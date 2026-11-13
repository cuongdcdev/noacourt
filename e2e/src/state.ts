import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Fixture } from "./fixtures.js";
import type { Scenario } from "./constants.js";
import { getJson } from "./net.js";

export type TxRecord = {
  hash: string;
  signer: string;
  receiver: string;
  method: string;
  signedBase64?: string;
  confirmedAt?: string;
  outcome?: unknown;
};

export type RunState = {
  scenario: Scenario;
  startedAt: string;
  file: string;
  stage: string;
  spec: Record<string, any>;
  specJson: string;
  specHash: string;
  durationMinutes: number;
  effectiveDurationMinutes?: number;
  resolutionWindowMinutes: number;
  courtMaxAttempts?: number;
  price?: { value: string; venue: string };
  balanceBefore?: string;
  spendReserved?: boolean;
  fixture?: Fixture;
  marketId?: number;
  txs: Record<string, TxRecord>;
  keeper: Record<string, string[]>;
  fallbacks: string[];
  skippedBets?: Record<string, string>;
  sawUnresolvable?: boolean;
  notes?: string[];
  events: { at: string; message: string }[];
  court?: any;
  linkRejection?: string;
  negative?: {
    firstRejectionAt?: string;
    reason?: string;
    linkAttempts?: number;
    permanent?: boolean;
    observedForMs?: number;
    everLinked?: boolean;
    creatorBalanceAfterCreate?: string;
    creatorBalanceAfterVoid?: string;
    creatorResidualZero?: boolean;
    marketSettledEvent?: boolean;
    stakeReturned?: boolean;
    voidedBy?: string;
  };
  noa?: any;
  pendingResolution?: any;
  verdictRecord?: any;
  receiptOutcomes?: {
    triggerTx: string;
    receiptId: string;
    executor: string;
    status: unknown;
  }[];
  resolveReceipts?: { triggerTx: string; receiptId: string }[];
  independent?: any;
  pass?: boolean;
  error?: string;
  rowWritten?: boolean;
};

export async function save(state: RunState): Promise<void> {
  await mkdir(dirname(state.file), { recursive: true });
  const temp = `${state.file}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n");
  await rename(temp, state.file);
}

export async function load(path: string): Promise<RunState> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as RunState;
}

export function note(state: RunState, message: string): void {
  state.events.push({ at: new Date().toISOString(), message });
  process.stdout.write(`[${state.scenario}] ${message}\n`);
}

export function txLink(hash: string | undefined): string {
  return hash
    ? `[${hash.slice(0, 9)}](https://testnet.nearblocks.io/txns/${hash})`
    : "";
}

function hashes(state: RunState, prefixes: string[]): string[] {
  const local = Object.entries(state.txs)
    .filter(([key, tx]) =>
      prefixes.some(
        (p) => key.startsWith(p) || tx.method === p || tx.method.startsWith(p),
      ),
    )
    .map(([, tx]) => tx.hash);
  const keeper = prefixes.flatMap((prefix) => state.keeper[prefix] ?? []);
  return [...new Set([...local, ...keeper])];
}

export function formatRow(state: RunState): string {
  const link = (list: string[]) => list.map(txLink).join(", ");
  const resolveInTrigger = new Set(
    (state.resolveReceipts ?? []).map((receipt) => receipt.triggerTx),
  );
  const resolveLinks = [
    ...new Set([
      ...hashes(state, [
        "resolve_market",
        "retry_forward",
        "void",
        "void_unlinked",
      ]),
      ...resolveInTrigger,
    ]),
  ]
    .map(
      (hash) =>
        `${txLink(hash)}${resolveInTrigger.has(hash) ? " (in trigger tx)" : ""}`,
    )
    .join(", ");
  const verdict = state.verdictRecord?.verdict ?? state.verdictRecord;
  const outcome =
    state.noa?.winning_outcome ??
    state.pendingResolution?.proposed_outcome ??
    verdict?.outcome_index;
  const cells = [
    state.startedAt,
    state.scenario,
    state.marketId ?? "",
    state.specHash.slice(0, 18),
    link(hashes(state, ["create_market"])),
    link(hashes(state, ["link_market"])),
    link(hashes(state, ["trigger", "submit_keeper_verdict"])),
    resolveLinks,
    link(hashes(state, ["finalize_resolution"])),
    link(hashes(state, ["claim_"])),
    state.scenario === "NEGW"
      ? `link rejected / ${state.noa?.status ?? ""}`
      : `${verdict?.status ?? state.court?.state ?? ""} / ${outcome ?? ""}`,
    state.scenario === "NEGW"
      ? "n/a"
      : state.verdictRecord?.tee === true
        ? "true"
        : state.verdictRecord?.tee === false
          ? "false"
          : "unknown",
    state.independent?.summary ?? "",
    state.pass === true ? "PASS" : "FAIL",
    [
      state.effectiveDurationMinutes !== undefined
        ? `duration: ${state.effectiveDurationMinutes}m (planned ${state.durationMinutes}m)`
        : "",
      state.fallbacks.length ? `fallback: ${state.fallbacks.join(", ")}` : "",
      ...(state.notes ?? []),
      state.error ?? "",
    ]
      .filter(Boolean)
      .join("; "),
  ];
  return `| ${cells.map((cell) => String(cell).replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |\n`;
}

let rowTail: Promise<unknown> = Promise.resolve();

export function insertResultRow(
  markdown: string,
  row: string,
  scenario: string,
  marketId: number,
): string {
  const lines = markdown.split("\n");
  const marker = `| ${scenario} | ${marketId} |`;
  const existing = lines.findIndex((line) => line.includes(marker));
  const newlineSuffix = markdown.includes("\r\n") ? "\r" : "";
  const formattedRow = row.trimEnd() + newlineSuffix;

  if (existing >= 0) {
    lines[existing] = formattedRow;
    return lines.join("\n");
  }

  const header = lines.findIndex((line) =>
    line.startsWith("| Date (UTC) | Scenario |"),
  );
  if (header < 0) throw new Error("E2E results table header not found");

  let afterTable = header + 1;
  while (afterTable < lines.length && /^\|.*\|\s*$/.test(lines[afterTable])) {
    afterTable++;
  }
  lines.splice(afterTable, 0, formattedRow);
  return lines.join("\n");
}

export async function appendRow(
  state: RunState,
  persistState = true,
): Promise<void> {
  if (state.marketId === undefined) return;
  const task = rowTail
    .catch(() => {})
    .then(async () => {
      const path = resolve(import.meta.dirname, "../../E2E_RESULTS.md");
      const current = await readFile(path, "utf8");
      const updated = insertResultRow(
        current,
        formatRow(state),
        state.scenario,
        state.marketId!,
      );
      await writeFile(`${path}.tmp`, updated);
      await rename(`${path}.tmp`, path);
      if (persistState) {
        state.rowWritten = true;
        await save(state);
      }
    });
  rowTail = task;
  await task;
}

export async function collectKeeper(state: RunState): Promise<void> {
  if (state.marketId === undefined) return;
  const log = resolve(import.meta.dirname, "../../apps/mcp/data/keeper.log");
  try {
    const data = await readFile(log, "utf8");
    for (const line of data.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id !== `noa:${state.marketId}`) continue;
        if (
          entry.action === "link_market" &&
          typeof entry.error === "string" &&
          /returned false|link_rejected/i.test(entry.error)
        )
          state.linkRejection = entry.error;
        if (typeof entry.tx_hash !== "string") continue;
        const list = state.keeper[entry.action] ?? [];
        if (!list.includes(entry.tx_hash)) list.push(entry.tx_hash);
        state.keeper[entry.action] = list;
      } catch {
        /* partial line */
      }
    }
  } catch {
    /* remote keeper log is not mounted */
  }
}

export async function keeperLinkEvidence(marketId: number): Promise<{
  attempts: number;
  firstRejectionAt?: string;
  reason?: string;
  permanent: boolean;
  voidTx?: string;
}> {
  const path = resolve(import.meta.dirname, "../../apps/mcp/data/keeper.log");
  const lines = (await readFile(path, "utf8")).split("\n");
  const links: any[] = [];
  let voidTx: string | undefined;
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id !== `noa:${marketId}`) continue;
      if (entry.action === "link_market") links.push(entry);
      if (
        entry.action === "void_unlinked" &&
        entry.result === "ok" &&
        entry.tx_hash
      )
        voidTx = entry.tx_hash;
    } catch {
      // A partial keeper log line may be in progress.
    }
  }
  const rejected = links.find(
    (entry) =>
      entry.permanent === true &&
      entry.result === "rejected" &&
      /resolution window too short for retries/i.test(
        `${entry.reason ?? ""} ${entry.error ?? ""}`,
      ),
  );
  return {
    attempts: links.length,
    firstRejectionAt: rejected?.ts,
    reason: rejected?.reason ?? rejected?.error,
    permanent: Boolean(rejected),
    voidTx,
  };
}

export async function latestKeeperActionAt(
  marketId: number,
  action: string,
): Promise<number | undefined> {
  const path = resolve(import.meta.dirname, "../../apps/mcp/data/keeper.log");
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let latest: number | undefined;
  for (const line of data.split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id !== `noa:${marketId}` || entry.action !== action) continue;
      const at = Date.parse(entry.ts);
      if (Number.isFinite(at)) latest = Math.max(latest ?? 0, at);
    } catch {
      // A partial keeper log line may be in progress.
    }
  }
  return latest;
}

export async function collectNearBlocks(state: RunState): Promise<void> {
  if (state.marketId === undefined) return;
  try {
    const base = "https://api-testnet.nearblocks.io/v3";
    const methods = new Set([
      "link_market",
      "trigger",
      "submit_keeper_verdict",
      "retry_forward",
      "void",
      "void_unlinked",
      "finalize_resolution",
    ]);
    const earliest = Date.parse(state.startedAt) - 5 * 60_000;
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const suffix: string = cursor
        ? `&next=${encodeURIComponent(cursor)}`
        : "";
      const data: any = await getJson(
        `${base}/accounts/court-ops.noamarket.testnet/txns?limit=100${suffix}`,
      );
      const rows: any[] = Array.isArray(data.data) ? data.data : [];
      for (const row of rows) {
        const hash = row.transaction_hash;
        if (
          typeof hash !== "string" ||
          !row.actions?.some((action: any) => methods.has(action.method))
        )
          continue;
        const detail = await getJson(`${base}/txns/${hash}`);
        for (const action of detail.data?.actions ?? []) {
          const method = action.method ?? action.args?.method_name;
          const args = action.args?.args_json ?? {};
          if (
            !methods.has(method) ||
            (String(args.market_id ?? "") !== String(state.marketId) &&
              String(args.id ?? "") !== `noa:${state.marketId}`)
          )
            continue;
          const list = state.keeper[method] ?? [];
          if (!list.includes(hash)) list.push(hash);
          state.keeper[method] = list;
        }
      }
      if (
        rows.length === 0 ||
        rows.some(
          (row) =>
            Number(BigInt(String(row.block_timestamp ?? "0")) / 1_000_000n) <
            earliest,
        )
      )
        break;
      cursor = data.meta?.next_page ?? null;
      if (!cursor) break;
    }
  } catch {
    /* keeper log and on-chain state still provide evidence */
  }
}

export async function inspectTriggerReceipts(
  state: RunState,
  status: (hash: string, signer: string) => Promise<any>,
): Promise<void> {
  const triggerHashes = [
    ...(state.keeper.trigger ?? []),
    ...(state.keeper.submit_keeper_verdict ?? []),
    ...hashes(state, ["trigger", "submit_keeper_verdict"]),
  ];
  for (const hash of new Set(triggerHashes)) {
    const signer =
      Object.values(state.txs).find((tx) => tx.hash === hash)?.signer ??
      "court-ops.noamarket.testnet";
    let result: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await status(hash, signer);
        break;
      } catch {
        if (attempt < 2)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    let resolveIds = findResolveMarketReceipts(result);
    if (resolveIds.length === 0) {
      try {
        result = await getJson(
          `https://api-testnet.nearblocks.io/v3/txns/${hash}/receipts`,
        );
        resolveIds = findResolveMarketReceipts(result);
      } catch {
        /* RPC receipt evidence may still be available on a later run. */
      }
    }
    if (!result) continue;
    for (const receiptId of resolveIds) {
      const list = state.resolveReceipts ?? [];
      if (!list.some((item) => item.receiptId === receiptId))
        list.push({ triggerTx: hash, receiptId });
      state.resolveReceipts = list;
      const hashes = state.keeper.resolve_market ?? [];
      if (!hashes.includes(hash)) hashes.push(hash);
      state.keeper.resolve_market = hashes;
    }
    try {
      const receipts = result.receipts_outcome ?? [];
      for (const receipt of receipts) {
        const id = receipt.id ?? "";
        const executor = receipt.outcome?.executor_id;
        if (typeof id === "string" && typeof executor === "string") {
          const list = state.receiptOutcomes ?? [];
          if (!list.some((item) => item.receiptId === id))
            list.push({
              triggerTx: hash,
              receiptId: id,
              executor,
              status: receipt.outcome?.status,
            });
          state.receiptOutcomes = list;
        }
      }
      state.events.push({
        at: new Date().toISOString(),
        message: `trigger ${hash}: ${receipts.length} receipt outcomes`,
      });
    } catch {
      /* Receipt outcomes are optional in explorer responses. */
    }
  }
}

export function findResolveMarketReceipts(result: any): string[] {
  const ids = new Set<string>();
  const visit = (receipt: any): void => {
    if (!receipt || typeof receipt !== "object") return;
    const receiver = receipt.receiver_id ?? receipt.receiver_account_id;
    const predecessor =
      receipt.predecessor_id ?? receipt.predecessor_account_id;
    const actions = receipt.receipt?.Action?.actions ?? receipt.actions ?? [];
    const resolves = actions.some(
      (action: any) =>
        (action.FunctionCall?.method_name ??
          action.method ??
          action.args?.method_name) === "resolve_market",
    );
    const id = receipt.receipt_id ?? receipt.id;
    if (
      receiver === "v3.noamarket.testnet" &&
      (!predecessor || predecessor === "ai-resolver.noamarket.testnet") &&
      resolves &&
      typeof id === "string"
    )
      ids.add(id);
    for (const child of receipt.receipts ?? []) visit(child);
  };
  for (const receipt of result?.receipts ?? []) visit(receipt);
  visit(result?.data);
  return [...ids];
}
