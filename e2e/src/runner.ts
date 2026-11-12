import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCreateMarketTxs,
  parseCreateMarketResult,
  type BuildInput,
  type WalletTransaction,
} from "../../apps/mcp/src/sign/txBuilder.js";
import { linkRejectionReason } from "../../apps/mcp/src/court/client.js";
import { AccountMutex } from "./accountMutex.js";
import {
  COURT,
  NOA,
  TOKEN,
  USER,
  UA,
  isFailure,
  isText,
  parseScenarioTarget,
  type Scenario,
} from "./constants.js";
import {
  createFixture,
  mutateFixture,
  publishStaticFixtures,
} from "./fixtures.js";
import { lintSpec } from "./lint.js";
import {
  bucketOutcome,
  changeOutcome,
  decimalUnits,
  thresholdOutcome,
  unitsDecimal,
  yocto,
} from "./math.js";
import { candle, livePrice, Rpc, TransientRpcError } from "./net.js";
import { retireFailedCreate, Sender, type Call } from "./sign.js";
import {
  appendRow,
  collectKeeper,
  collectNearBlocks,
  inspectTriggerReceipts,
  load,
  note,
  save,
  type RunState,
} from "./state.js";
import {
  buildSpec,
  canonicalSpec,
  effectiveMarketDurationMinutes,
} from "./specs.js";

const rpc = new Rpc();
const sender = new Sender(rpc);
const accountMutex = new AccountMutex();
const root = resolve(import.meta.dirname, "../..");
const results = resolve(root, "e2e/results");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const COURT_TRIGGER_GAS_TGAS = 300;

async function view<T>(
  contract: string,
  method: string,
  args: unknown,
): Promise<T> {
  return rpc.view<T>(contract, method, args);
}

async function mcpTool(name: string, args: unknown): Promise<any> {
  const response = await fetch("https://noacourtmcp.junstudio.xyz/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": UA,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`MCP ${name} HTTP ${response.status}`);
  const body = (await response.json()) as any;
  if (body.error || body.result?.isError)
    throw new Error(
      `MCP ${name}: ${JSON.stringify(body.error ?? body.result?.content)}`,
    );
  const text = body.result?.content?.find(
    (part: any) => part.type === "text",
  )?.text;
  try {
    return text ? JSON.parse(text) : body.result;
  } catch {
    return text ?? body.result;
  }
}

async function accountBalance(account: string): Promise<string> {
  return String(
    await view<string>(NOA, "get_user_balance", {
      account_id: account,
      token_id: TOKEN,
    }),
  );
}

async function prepare(scenario: Scenario, dryRun: boolean): Promise<RunState> {
  const now = new Date();
  const durationMinutes = isFailure(scenario) ? 5 : 10;
  const resolutionWindowMinutes = isFailure(scenario) ? 10 : 15;
  const fixture =
    !dryRun && (isFailure(scenario) || isText(scenario))
      ? await createFixture(scenario)
      : undefined;
  const symbol = scenario === "A1" ? "NEARUSDT" : "BTCUSDT";
  const price = ["A1", "A2", "A3"].includes(scenario)
    ? await livePrice(symbol)
    : undefined;
  const balanceBefore =
    scenario === "A4"
      ? await view<string>(TOKEN, "ft_balance_of", { account_id: USER(3) })
      : undefined;
  const spec = buildSpec({
    scenario,
    now,
    price: price?.value,
    venue: price?.venue,
    balance: balanceBefore,
    fixtureUrl: fixture?.url,
  });
  const { specJson, specHash } = canonicalSpec(spec);
  const file = resolve(
    results,
    `${now.toISOString().replaceAll(":", "-")}-${scenario}.json`,
  );
  return {
    scenario,
    startedAt: now.toISOString(),
    file,
    stage: "prepared",
    spec,
    specJson,
    specHash,
    durationMinutes,
    resolutionWindowMinutes,
    price,
    balanceBefore,
    fixture,
    txs: {},
    keeper: {},
    fallbacks: [],
    events: [],
  };
}

async function plan(
  state: RunState,
  dryRun: boolean,
): Promise<{ input: BuildInput; transactions: WalletTransaction[] }> {
  const balance = await accountBalance(USER(1));
  const courtConfig = await view<any>(COURT, "get_config", {});
  if (courtConfig.resolver_source?.Project?.version_key == null) {
    process.stderr.write(
      `[${state.scenario}] WARNING: Court resolver project has no pinned version_key; pin the deployed resolver before claiming a pinned TEE run.\n`,
    );
  }
  const input: BuildInput = {
    spec_json: state.specJson,
    spec_hash: state.specHash,
    title: state.spec.question,
    outcomes: state.spec.outcomes,
    stake: "100",
    token_id: TOKEN,
    token_decimals: 18,
    duration_minutes: state.durationMinutes,
    resolution_window_minutes: state.resolutionWindowMinutes,
    court_contract: COURT,
    noa_contract: NOA,
    register_deposit_yocto: String(courtConfig.min_deposit ?? yocto("0.1")),
    create_market_deposit_yocto: "0",
    internal_balance_yocto: balance,
    signer_id: USER(1),
    creator: USER(1),
  };
  const transactions = buildCreateMarketTxs(input);
  if (dryRun) {
    process.stdout.write(
      `[${state.scenario}] spec_hash=${state.specHash} observation=${state.spec.observation.at} price=${state.price?.value ?? "n/a"}\n`,
    );
    process.stdout.write(
      `[${state.scenario}] create plan: ${JSON.stringify(transactions)}\n`,
    );
  }
  return { input, transactions };
}

let spendTail: Promise<unknown> = Promise.resolve();

async function spendReserve(state: RunState): Promise<void> {
  if (!isText(state.scenario) || state.spendReserved) return;
  const task = spendTail.catch(() => {}).then(() => reserveOne(state));
  spendTail = task;
  await task;
}

async function reserveOne(state: RunState): Promise<void> {
  const path = resolve(results, "spend.json");
  await mkdir(results, { recursive: true });
  let ledger: {
    estimatedUsd: number;
    reservations: {
      scenario: string;
      file: string;
      at: string;
      estimateUsd: number;
    }[];
  };
  try {
    ledger = JSON.parse(await readFile(path, "utf8"));
  } catch {
    ledger = { estimatedUsd: 0, reservations: [] };
  }
  if (ledger.reservations.some((item) => item.file === state.file)) {
    state.spendReserved = true;
    await save(state);
    return;
  }
  const cap = Number(process.env.E2E_NEAR_AI_CAP_USD ?? "5");
  const estimate = 0.05 * 3;
  if (!Number.isFinite(cap) || cap < 0 || ledger.estimatedUsd + estimate > cap)
    throw new Error(
      `NEAR AI estimate cap exceeded: ${ledger.estimatedUsd + estimate} > ${cap}`,
    );
  ledger.estimatedUsd += estimate;
  ledger.reservations.push({
    scenario: state.scenario,
    file: state.file,
    at: new Date().toISOString(),
    estimateUsd: estimate,
  });
  await writeFile(path, JSON.stringify(ledger, null, 2) + "\n");
  state.spendReserved = true;
  await save(state);
}

async function settleSpend(state: RunState): Promise<void> {
  if (!isText(state.scenario)) return;
  const task = spendTail
    .catch(() => {})
    .then(async () => {
      const path = resolve(results, "spend.json");
      const ledger = JSON.parse(await readFile(path, "utf8")) as {
        estimatedUsd: number;
        reservations: {
          file: string;
          estimateUsd: number;
          actualEstimateUsd?: number;
        }[];
      };
      const entry = ledger.reservations.find(
        (item) => item.file === state.file,
      );
      if (!entry || entry.actualEstimateUsd !== undefined) return;
      const attempts = Number(
        state.court?.attempts ?? state.court?.attempt ?? 0,
      );
      const actual =
        state.scenario === "A8n" ? 0 : Math.min(3, attempts) * 0.05;
      ledger.estimatedUsd = Math.max(
        0,
        ledger.estimatedUsd - entry.estimateUsd + actual,
      );
      entry.actualEstimateUsd = actual;
      await writeFile(path, JSON.stringify(ledger, null, 2) + "\n");
    });
  spendTail = task;
  await task;
}

function plannedCall(tx: WalletTransaction): Call {
  const action = tx.actions[0].params;
  return {
    signer: tx.signerId ?? USER(1),
    receiver: tx.receiverId,
    method: action.methodName,
    args: action.args,
    gasTgas: Number(BigInt(action.gas) / 1_000_000_000_000n),
    deposit: action.deposit,
  };
}

async function sendPlan(state: RunState): Promise<void> {
  await accountMutex.run(USER(1), () => sendPlanLocked(state));
}

async function waitFinal(hash: string, signer: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let result: any;
    try {
      result = await rpc.status(hash, signer);
    } catch {
      await sleep(1_000);
      continue;
    }
    if (result.final_execution_status === "FAILURE" || result.status?.Failure)
      throw new Error(
        `${hash} failed before finality: ${JSON.stringify(result.status?.Failure ?? result)}`,
      );
    if (result.final_execution_status === "FINAL") return;
    await sleep(1_000);
  }
  throw new Error(
    `${hash} did not reach finality within two minutes; resume this results file`,
  );
}

function creatorTopupLabel(state: RunState): string {
  const pending = Object.entries(state.txs).find(
    ([label, tx]) =>
      (label === "ft_transfer_call" || label.startsWith("topup_creator_")) &&
      tx.method === "ft_transfer_call" &&
      !tx.confirmedAt,
  );
  if (pending) return pending[0];
  const prior = Object.keys(state.txs).filter((label) =>
    label.startsWith("topup_creator_"),
  ).length;
  return `topup_creator_${prior + 1}`;
}

async function sendPlanLocked(state: RunState): Promise<void> {
  if (retireFailedCreate(state)) await save(state);
  if (state.txs.create_market?.confirmedAt) {
    state.marketId = parseCreateMarketResult(
      state.txs.create_market.outcome,
    ).market_id;
    await waitFinal(state.txs.create_market.hash, USER(1));
    await save(state);
    return;
  }
  const { input, transactions } = await plan(state, false);
  for (const tx of transactions) {
    const method = tx.actions[0].params.methodName;
    if (method === "register_spec" && state.txs.register_spec?.confirmedAt) {
      await waitFinal(state.txs.register_spec.hash, USER(1));
      continue;
    }
    const label =
      method === "ft_transfer_call" ? creatorTopupLabel(state) : method;
    let call = plannedCall(tx);
    let beforeSign: (() => Promise<Call>) | undefined;
    if (method === "create_market") {
      const createCall = (durationMinutes: number): Call => {
        const rebuilt = buildCreateMarketTxs({
          ...input,
          duration_minutes: durationMinutes,
        });
        const createTx = rebuilt.find(
          (candidate) =>
            candidate.actions[0].params.methodName === "create_market",
        );
        if (!createTx)
          throw new Error("Rebuilt plan has no create_market transaction");
        return plannedCall(createTx);
      };
      if (state.txs.create_market) {
        if (state.effectiveDurationMinutes !== undefined)
          call = createCall(state.effectiveDurationMinutes);
      } else {
        beforeSign = async () => {
          const effective = effectiveMarketDurationMinutes(
            state.durationMinutes,
            state.spec.observation.at,
            Date.now(),
          );
          state.effectiveDurationMinutes = effective;
          await save(state);
          if (!Number.isInteger(effective) || effective < 5) {
            throw new Error(
              `Cannot create market: only ${effective} safe minutes remain before observation ${state.spec.observation.at}; Noa requires at least 5. Spec registration succeeded, but no market was created. The credit remains with ${USER(1)}. Start a fresh run.`,
            );
          }
          return createCall(effective);
        };
      }
    }
    const record = await sender.send(state, label, call, beforeSign);
    note(state, `${method} ${record.hash}`);
    await waitFinal(record.hash, USER(1));
    if (method === "create_market")
      state.marketId = parseCreateMarketResult(record.outcome).market_id;
    await save(state);
  }
}

async function sendCall(
  state: RunState,
  label: string,
  signer: string,
  receiver: string,
  method: string,
  args: Record<string, unknown>,
  gasTgas: number,
  deposit = "0",
): Promise<void> {
  const tx = await sender.send(state, label, {
    signer,
    receiver,
    method,
    args,
    gasTgas,
    deposit,
  });
  note(state, `${label} ${tx.hash}`);
}

async function afterCreate(state: RunState): Promise<void> {
  if (state.scenario === "A4" && !state.txs.a4_transfer) {
    await sendCall(
      state,
      "a4_transfer",
      USER(5),
      TOKEN,
      "ft_transfer",
      {
        receiver_id: USER(3),
        amount: decimalUnits("1000").toString(),
        memo: "Noa Court A4 E2E",
      },
      100,
      "1",
    );
  }
  if (
    state.fixture &&
    !state.fixture.mutatedAt &&
    !state.fixture.deletedAt &&
    state.scenario !== "A8n"
  ) {
    state.fixture = await mutateFixture(state.scenario, state.fixture);
    note(
      state,
      `fixture ${state.fixture.deletedAt ? "deleted" : "mutated"} at ${state.fixture.deletedAt ?? state.fixture.mutatedAt}`,
    );
    await save(state);
  }
}

async function snapshot(state: RunState): Promise<void> {
  if (state.marketId === undefined) throw new Error("Market ID missing");
  const id = state.marketId;
  const [court, noa, pending, verdict] = await Promise.all([
    view<any>(COURT, "get_market", { market_id: id }),
    view<any>(NOA, "get_market", { market_id: id }),
    view<any>(NOA, "get_pending_resolution", { market_id: id }),
    view<any>(COURT, "get_verdict", { id: `noa:${id}` }),
  ]);
  state.court = court;
  state.noa = noa;
  state.pendingResolution = pending;
  state.verdictRecord = verdict;
  await collectKeeper(state);
  await save(state);
}

async function pollSnapshot(state: RunState): Promise<boolean> {
  try {
    await snapshot(state);
    return true;
  } catch (error) {
    if (!(error instanceof TransientRpcError)) throw error;
    note(
      state,
      `transient RPC snapshot failure; polling continues: ${error.message}`,
    );
    await save(state);
    return false;
  }
}

function courtState(state: RunState): string {
  const raw = state.court?.status ?? state.court?.state;
  return typeof raw === "string"
    ? raw.toLowerCase()
    : raw && typeof raw === "object"
      ? (Object.keys(raw)[0]?.toLowerCase() ?? "")
      : "";
}

function linkFailure(state: RunState): string | null {
  if (state.linkRejection) return state.linkRejection;
  const fallbackTx = Object.entries(state.txs).find(([label]) =>
    label.startsWith("fallback_link_market"),
  )?.[1];
  if (!fallbackTx?.outcome) return null;
  const reason = linkRejectionReason(fallbackTx.outcome);
  const encoded = (fallbackTx.outcome as any)?.status?.SuccessValue;
  const returnedFalse =
    typeof encoded === "string" &&
    Buffer.from(encoded, "base64").toString("utf8") === "false";
  if (reason || returnedFalse)
    return `Court link_market returned false: ${reason ?? "see link_rejected event"}`;
  return null;
}

async function refreshFallbackLinkOutcome(state: RunState): Promise<void> {
  const fallbackTx = Object.entries(state.txs).find(([label]) =>
    label.startsWith("fallback_link_market"),
  )?.[1];
  if (!fallbackTx || linkFailure(state)) return;
  try {
    fallbackTx.outcome = await rpc.status(fallbackTx.hash, fallbackTx.signer);
    await save(state);
  } catch {
    // Keep polling Court and the keeper log while RPC status is unavailable.
  }
}

async function fallback(
  state: RunState,
  action:
    | "link_market"
    | "trigger"
    | "void"
    | "finalize_resolution"
    | "retry_forward",
): Promise<void> {
  const id = state.marketId!;
  const label = `fallback_${action}_${state.fallbacks.length}`;
  note(state, `FALLBACK ${action}: keeper action is over three minutes late`);
  const call =
    action === "finalize_resolution"
      ? { receiver: NOA, args: { market_id: id }, gas: 100, deposit: "1" }
      : {
          receiver: COURT,
          args:
            action === "link_market"
              ? { market_id: id, spec_hash: null }
              : { market_id: id },
          gas: ["trigger", "trigger_request"].includes(action)
            ? COURT_TRIGGER_GAS_TGAS
            : action === "link_market"
              ? 100
              : 80,
          deposit: "0",
        };
  try {
    await sendCall(
      state,
      label,
      USER(1),
      call.receiver,
      action,
      call.args,
      call.gas,
      call.deposit,
    );
    state.fallbacks.push(action);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    note(state, `FALLBACK ${action} FAILED: ${reason}`);
    state.fallbacks.push(action, `${action} failed: ${reason}`);
  }
  await save(state);
}

async function waitLinked(state: RunState): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 8 * 60_000) {
    if (!(await pollSnapshot(state))) {
      await sleep(15_000);
      continue;
    }
    if (
      state.court &&
      [
        "linked",
        "pending",
        "retryscheduled",
        "resolved",
        "unresolvable",
      ].includes(courtState(state))
    )
      return;
    await refreshFallbackLinkOutcome(state);
    const rejection = linkFailure(state);
    if (rejection)
      throw new Error(`Market ${state.marketId} link rejected: ${rejection}`);
    if (
      Date.now() - started > 3 * 60_000 &&
      !state.fallbacks.includes("link_market")
    ) {
      await fallback(state, "link_market");
      await refreshFallbackLinkOutcome(state);
      const fallbackRejection = linkFailure(state);
      if (fallbackRejection)
        throw new Error(
          `Market ${state.marketId} link rejected: ${fallbackRejection}`,
        );
    }
    await sleep(15_000);
  }
  throw new Error("Keeper did not link market within eight minutes");
}

async function bet(
  state: RunState,
  account: string,
  outcome: number,
): Promise<void> {
  await accountMutex.run(account, () => betLocked(state, account, outcome));
}

async function betLocked(
  state: RunState,
  account: string,
  outcome: number,
): Promise<void> {
  const id = state.marketId!;
  const label = `bet_${account}_${outcome}`;
  if (state.txs[label]?.confirmedAt) {
    await waitFinal(state.txs[label].hash, account);
    return;
  }
  const token = await view<any>(NOA, "get_whitelisted_token", {
    token_id: TOKEN,
  });
  const min = BigInt(String(token.min_trade_amount ?? "0"));
  const spend = min > decimalUnits("10") ? min : decimalUnits("10");
  const needed = spend + spend / 50n + decimalUnits("1");
  const current = BigInt(await accountBalance(account));
  if (current < needed) {
    const topupLabel = `topup_${account}`;
    await sendCall(
      state,
      topupLabel,
      account,
      TOKEN,
      "ft_transfer_call",
      { receiver_id: NOA, amount: (needed - current).toString(), msg: "" },
      100,
      "1",
    );
    await waitFinal(state.txs[topupLabel].hash, account);
  }
  // 0.01 NEAR covers first-position storage; Noa requires at least 0.002 NEAR.
  await sendCall(
    state,
    label,
    account,
    NOA,
    "buy_shares",
    {
      market_id: id,
      outcome_id: outcome,
      spend_amount_max: spend.toString(),
      min_shares_expected_fp: "0",
    },
    100,
    yocto("0.01"),
  );
  await waitFinal(state.txs[label].hash, account);
}

async function waitTerminal(state: RunState): Promise<void> {
  const at = Date.parse(state.spec.observation.at);
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    if (!(await pollSnapshot(state))) {
      await sleep(15_000);
      continue;
    }
    const c = courtState(state);
    if (
      state.noa?.status === "Void" ||
      state.noa?.status === "Resolved" ||
      (c === "resolved" && state.pendingResolution)
    )
      return;
    const now = Date.now();
    const noaDeadline = Number(
      BigInt(String(state.noa?.resolution_deadline ?? "0")) / 1_000_000n,
    );
    const retryAt = Number(
      BigInt(String(state.court?.retry_at_ns ?? state.court?.retry_at ?? "0")) /
        1_000_000n,
    );
    if (
      c === "resolved" &&
      state.court?.forwarded === false &&
      now > at + 3 * 60_000 &&
      !state.fallbacks.includes("retry_forward")
    ) {
      await fallback(state, "retry_forward");
    } else if (
      c === "unresolvable" &&
      noaDeadline &&
      now > noaDeadline + 3 * 60_000 &&
      !state.fallbacks.includes("void")
    ) {
      await fallback(state, "void");
    } else if (
      ["linked", "retryscheduled"].includes(c) &&
      now > Math.max(at, retryAt) + 3 * 60_000 &&
      now < noaDeadline &&
      !state.fallbacks.includes(`trigger:${state.court?.attempts ?? 0}`)
    ) {
      await fallback(state, "trigger");
      state.fallbacks.push(`trigger:${state.court?.attempts ?? 0}`);
    }
    await sleep(15_000);
  }
  throw new Error("Market did not reach a terminal state within 45 minutes");
}

async function waitFinalized(state: RunState): Promise<void> {
  if (state.noa?.status !== "Active") return;
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    if (!(await pollSnapshot(state))) {
      await sleep(15_000);
      continue;
    }
    if (state.noa?.status === "Resolved" || state.noa?.status === "Void")
      return;
    const dispute = Number(
      BigInt(String(state.pendingResolution?.dispute_deadline ?? "0")) /
        1_000_000n,
    );
    if (
      dispute &&
      Date.now() > dispute + 3 * 60_000 &&
      !state.fallbacks.includes("finalize_resolution")
    )
      await fallback(state, "finalize_resolution");
    await sleep(15_000);
  }
  throw new Error("Noa finalization not observed within 25 minutes");
}

async function claim(state: RunState): Promise<void> {
  const winners =
    state.noa?.status === "Void"
      ? [USER(2), USER(4), ...(state.spec.outcomes.length > 2 ? [USER(5)] : [])]
      : [
          [USER(2), USER(4), USER(5)][Number(state.noa?.winning_outcome)],
        ].filter(Boolean);
  for (const account of winners)
    await sendCall(
      state,
      `claim_${account}`,
      account,
      NOA,
      "claim_winnings",
      { market_id: state.marketId },
      100,
      "1",
    );
}

async function independent(state: RunState): Promise<void> {
  const scenario = state.scenario;
  const verdict = state.verdictRecord?.verdict ?? state.verdictRecord;
  const finalIndex = state.noa?.winning_outcome;
  if (scenario === "A6" || scenario === "A7") {
    const attempts = Number(state.court?.attempts ?? state.court?.attempt ?? 0);
    const valid =
      state.noa?.status === "Void" &&
      courtState(state) === "voided" &&
      attempts >= 3 &&
      !state.pendingResolution &&
      verdict?.status !== "resolved" &&
      !state.keeper.resolve_market?.length;
    state.independent = {
      expected: "Void",
      actual: state.noa?.status,
      attempts,
      summary: `void; attempts=${attempts}; no pending=${!state.pendingResolution}; verdict=${verdict?.status ?? "none"}`,
    };
    state.pass = valid;
  } else if (["A8", "A8n", "A9"].includes(scenario)) {
    const actual = state.spec.outcomes[Number(finalIndex)] ?? null;
    const expected =
      scenario === "A8" ? "Yes" : scenario === "A8n" ? "No" : "not Yes";
    const jurors = verdict?.jurors ?? [];
    state.independent = {
      expected,
      actual,
      jurors,
      summary: `${expected}; actual=${actual}; jurors=${jurors.length}`,
    };
    state.pass =
      scenario === "A9"
        ? actual !== "Yes" && ["Resolved", "Void"].includes(state.noa?.status)
        : actual === expected && state.noa?.status === "Resolved";
    if (scenario === "A8")
      state.pass &&=
        jurors.length === 3 &&
        jurors.every((j: any) => j.valid === true && j.answer === "yes");
    if (scenario === "A8n") state.pass &&= jurors.length === 0;
  } else if (scenario === "A4") {
    const raw = await view<string>(TOKEN, "ft_balance_of", {
      account_id: USER(3),
    });
    const actual = unitsDecimal(BigInt(raw));
    const expected = thresholdOutcome(actual, String(state.spec.decide.value));
    state.independent = {
      raw,
      actual,
      expected,
      threshold: state.spec.decide.value,
      summary: `${actual} >= ${state.spec.decide.value}: ${expected}`,
    };
    state.pass =
      state.noa?.status === "Resolved" &&
      expected === "Yes" &&
      state.spec.outcomes[Number(finalIndex)] === expected;
  } else {
    const symbol = scenario === "A1" ? "NEARUSDT" : "BTCUSDT";
    const preferred = (
      state.spec.sources[0].tool === "okx_candle" ? "okx" : "binance"
    ) as "binance" | "okx";
    const sourceId = verdict?.sources?.find(
      (source: any) => source.ok === true,
    )?.id;
    const venue =
      sourceId === "okx"
        ? "okx"
        : sourceId === "binance"
          ? "binance"
          : preferred;
    const primary = await candle(symbol, state.spec.observation.at, venue);
    let secondary: any = null;
    try {
      secondary = await candle(
        symbol,
        state.spec.observation.at,
        venue === "binance" ? "okx" : "binance",
      );
    } catch (error) {
      secondary = { error: String(error) };
    }
    const baseline =
      scenario === "A3"
        ? await candle(symbol, state.spec.observation.baseline_at, venue)
        : null;
    const expected =
      scenario === "A1"
        ? thresholdOutcome(primary.value, String(state.spec.decide.value))
        : scenario === "A2"
          ? bucketOutcome(primary.value, state.spec.decide.edges)
          : changeOutcome(primary.value, baseline!.value);
    state.independent = {
      primary,
      secondary,
      baseline,
      expected,
      selectedSource: sourceId,
      summary: `${primary.venue} ${primary.value} ${scenario === "A3" ? `vs ${baseline?.value}` : ""} => ${expected}`,
    };
    state.pass =
      state.noa?.status === "Resolved" &&
      state.spec.outcomes[Number(finalIndex)] === expected;
  }
  await save(state);
}

async function execute(state: RunState): Promise<void> {
  if (["prepared", "preflight"].includes(state.stage)) {
    const latestSafeStart = Date.now() + (state.durationMinutes + 1) * 60_000;
    if (Date.parse(state.spec.observation.at) < latestSafeStart) {
      throw new Error(
        `Observation ${state.spec.observation.at} is too close for a new ${state.durationMinutes}-minute market. Start a fresh run; do not reuse or change this saved spec.`,
      );
    }
  }
  state.error = undefined;
  await save(state);
  if (state.stage === "prepared") {
    await lintSpec(state.specJson);
    note(state, "local resolver lint OK");
    if (["A1", "A2", "A3", "A4"].includes(state.scenario)) {
      try {
        const simulation = await mcpTool("spec_simulate", { spec: state.spec });
        note(
          state,
          `preflight simulation: ${JSON.stringify(simulation).slice(0, 400)}`,
        );
      } catch (error) {
        note(state, `preflight simulation unavailable: ${String(error)}`);
      }
    }
    await spendReserve(state);
    state.stage = "preflight";
    await save(state);
  }
  if (state.stage === "preflight") {
    await sendPlan(state);
    state.stage = "created";
    await save(state);
  }
  if (state.stage === "created") {
    await afterCreate(state);
    state.stage = "mutated";
    await save(state);
  }
  if (state.stage === "mutated") {
    await waitLinked(state);
    state.stage = "linked";
    await save(state);
  }
  if (state.stage === "linked") {
    await bet(state, USER(2), 0);
    await bet(state, USER(4), 1);
    if (state.spec.outcomes.length > 2) await bet(state, USER(5), 2);
    state.stage = "bet";
    await save(state);
  }
  if (state.stage === "bet") {
    await waitTerminal(state);
    state.stage = "terminal";
    await save(state);
  }
  if (state.stage === "terminal") {
    await waitFinalized(state);
    state.stage = "finalized";
    await save(state);
  }
  if (state.stage === "finalized") {
    await claim(state);
    state.stage = "claimed";
    await save(state);
  }
  if (state.stage === "claimed") {
    await snapshot(state);
    await collectNearBlocks(state);
    await inspectTriggerReceipts(state, (hash, signer) =>
      rpc.status(hash, signer),
    );
    await independent(state);
    await settleSpend(state);
    state.stage = "checked";
    await save(state);
  }
  if (state.stage === "checked") {
    await appendRow(state);
    state.stage = "done";
    await save(state);
    note(
      state,
      `${state.pass ? "PASS" : "FAIL"} market ${state.marketId}; result ${state.file}`,
    );
  }
}

async function runOne(scenario: Scenario, dryRun: boolean): Promise<void> {
  const state = await prepare(scenario, dryRun);
  try {
    if (!dryRun) await save(state);
    await lintSpec(state.specJson);
    note(state, "local resolver lint OK");
    if (dryRun) {
      await plan(state, true);
      return;
    }
    await execute(state);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    if (!dryRun) {
      await save(state);
      if (state.marketId !== undefined) await appendRow(state);
    }
    process.stderr.write(
      `[${scenario}] ${state.error}${dryRun ? "" : `; resume ${state.file}`}\n`,
    );
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const target = args.find((arg) => !arg.startsWith("--"));
  if (target === "fixtures") {
    if (dryRun)
      throw new Error(
        "fixtures publishes gists; --dry-run has no publishing operation",
      );
    await publishStaticFixtures();
    process.stdout.write(
      "Static secret fixture gists published; URLs written to fixtures/gists.json and fixtures/README.md\n",
    );
    return;
  }
  if (target === "resume") {
    const file = args.find((arg) => arg.endsWith(".json"));
    if (!file) throw new Error("Usage: pnpm e2e resume <results-file>");
    const state = await load(file);
    try {
      await execute(state);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      await save(state);
      if (state.marketId !== undefined) await appendRow(state);
      throw error;
    }
    return;
  }
  if (target === "rerow") {
    const file = args.find((arg) => arg.endsWith(".json"));
    if (!file) throw new Error("Usage: pnpm e2e rerow <results-file>");
    const state = await load(file);
    await inspectTriggerReceipts(state, (hash, signer) =>
      rpc.status(hash, signer),
    );
    await appendRow(state, false);
    process.stdout.write(
      `Updated ${state.scenario} market ${state.marketId} row; saved result unchanged\n`,
    );
    return;
  }
  const scenarios = parseScenarioTarget(target);
  // Stagger creation slightly while allowing independent markets to progress concurrently.
  const settled = await Promise.allSettled(
    scenarios.map(async (scenario, index) => {
      if (!dryRun) await sleep(index * 5_000);
      return runOne(scenario, dryRun);
    }),
  );
  if (settled.some((item) => item.status === "rejected")) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
