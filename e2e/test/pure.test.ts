import assert from "node:assert/strict";
import test from "node:test";
import { AccountMutex } from "../src/accountMutex.js";
import { SCENARIOS, parseScenarioTarget } from "../src/constants.js";
import {
  evaluateVoid,
  marketTooLate,
  shouldSkipFallback,
  specTimingDecision,
} from "../src/decisions.js";
import { fixtureName, fixtureUrl } from "../src/fixtures.js";
import {
  bucketEdges,
  bucketOutcome,
  changeOutcome,
  decimalUnits,
  thresholdOutcome,
  yocto,
} from "../src/math.js";
import { rpcBackoffMs } from "../src/net.js";
import {
  findResolveMarketReceipts,
  formatRow,
  insertResultRow,
  type RunState,
} from "../src/state.js";
import {
  buildSpec,
  canonicalSpec,
  effectiveMarketDurationMinutes,
  observationTime,
} from "../src/specs.js";
import {
  classifyTxStatus,
  retireFailedCreate,
  retryDecision,
} from "../src/sign.js";

const now = new Date("2026-11-12T19:00:05Z");

test("creator lock wait rebuilds an unregistered spec and preserves registered specs", () => {
  const queuedAt = new Date("2026-11-12T23:00:08Z");
  const observationAt = observationTime(queuedAt, 8);
  const afterLockWait = queuedAt.getTime() + 3 * 60_000;
  const input = {
    observationAt,
    nowMs: afterLockWait,
    durationMinutes: 8,
  };
  assert.equal(specTimingDecision(input), "rebuild");
  assert.equal(
    specTimingDecision({
      ...input,
      registration: { confirmedAt: "2026-11-12T23:00:09Z" },
    }),
    "abort",
  );
  assert.equal(
    specTimingDecision({ ...input, registration: {} }),
    "resume_registration",
  );
  assert.equal(
    specTimingDecision({ ...input, nowMs: queuedAt.getTime() }),
    "keep",
  );
  const rebuilt = buildSpec({
    scenario: "A6",
    now: new Date(afterLockWait),
    durationMinutes: 8,
    fixtureUrl: "https://example.org/fixture.json",
  });
  assert.ok(Date.parse(rebuilt.observation.at) >= afterLockWait + 11 * 60_000);
});

test("fresh Court status suppresses stale trigger fallbacks", () => {
  for (const status of ["pending", "resolved", "unresolvable", "voided"])
    assert.equal(shouldSkipFallback(status, "trigger"), true);
  assert.equal(shouldSkipFallback("linked", "trigger"), false);
  assert.equal(shouldSkipFallback("linked", "link_market"), true);
});

test("bets skip at the 45-second expiration guard", () => {
  const nowMs = now.getTime();
  const market = (offsetMs: number) => ({
    status: "Active",
    expiration_time: String(BigInt(nowMs + offsetMs) * 1_000_000n),
  });
  assert.equal(marketTooLate(market(46_000), nowMs), false);
  assert.equal(marketTooLate(market(45_000), nowMs), true);
  assert.equal(marketTooLate(market(-1), nowMs), true);
  assert.equal(
    marketTooLate({ ...market(60_000), status: "Resolved" }, nowMs),
    true,
  );
});

test("void proof accepts deadline void after fewer than three attempts", () => {
  const evidence = {
    noaStatus: "Void",
    courtStatus: "voided",
    attempts: 2,
    pendingResolution: null,
    resolveReceiptCount: 0,
    verdictStatus: "retry_after",
    verdictReason: "assert_failed",
  };
  const result = evaluateVoid(evidence);
  assert.equal(result.pass, true);
  assert.match(
    result.note,
    /deadline void after 2 attempts; verdict errors: assert_failed/,
  );
  assert.equal(
    evaluateVoid({ ...evidence, sawUnresolvable: true }).path,
    "unresolvable->void",
  );
  assert.equal(
    evaluateVoid({ ...evidence, resolveReceiptCount: 1 }).pass,
    false,
  );
  assert.equal(
    evaluateVoid({ ...evidence, pendingResolution: {} }).pass,
    false,
  );
  assert.equal(
    evaluateVoid({ ...evidence, verdictStatus: "resolved" }).pass,
    false,
  );
  assert.equal(evaluateVoid({ ...evidence, attempts: 0 }).pass, false);
});

test("fixture names are unique-safe and URLs use the configured base", () => {
  const filename = fixtureName("A8n", now, "a1b2c3d4");
  assert.equal(filename, "e2e-a8n-20261112t190005000z-a1b2c3d4.xml");
  assert.equal(
    fixtureUrl(filename, "https://example.org/fixtures/"),
    `https://example.org/fixtures/${filename}`,
  );
  assert.match(fixtureName("A6", now, "12345678"), /\.json$/);
  assert.throws(() => fixtureUrl("../escape.json"), /Invalid fixture name/);
  assert.throws(() => fixtureUrl("bad.js"), /Invalid fixture name/);
});

test("RPC retry backoff grows to 30 seconds and honors Retry-After", () => {
  const nowMs = Date.parse("2026-11-12T19:00:00Z");
  assert.equal(rpcBackoffMs(0, null, nowMs), 500);
  assert.equal(rpcBackoffMs(3, null, nowMs), 4_000);
  assert.equal(rpcBackoffMs(10, null, nowMs), 30_000);
  assert.equal(rpcBackoffMs(0, "3", nowMs), 3_000);
  assert.equal(rpcBackoffMs(0, "Thu, 12 Nov 2026 19:00:07 GMT", nowMs), 7_000);
  assert.equal(rpcBackoffMs(1, "invalid", nowMs), 1_000);
});

test("account mutex holds a creator or bettor across the whole operation", async () => {
  const mutex = new AccountMutex();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = mutex.run("user1", async () => {
    order.push("first read");
    await firstGate;
    order.push("first confirmed");
  });
  const second = mutex.run("user1", async () => {
    order.push("second read");
  });
  const other = mutex.run("user2", async () => {
    order.push("other read");
  });
  await other;
  assert.deepEqual(order, ["first read", "other read"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first read",
    "other read",
    "first confirmed",
    "second read",
  ]);
});

test("failed create is archived before re-planning, preserving confirmed registration", () => {
  const state = {
    txs: {
      register_spec: {
        hash: "registered",
        confirmedAt: "2026-11-12T19:00:00Z",
      },
      create_market: {
        hash: "failed-create",
        outcome: {
          status: { Failure: { ActionError: "Insufficient balance" } },
        },
      },
    },
    events: [],
  } as unknown as RunState;
  assert.equal(retireFailedCreate(state), true);
  assert.equal(state.txs.create_market, undefined);
  assert.equal(state.txs.register_spec.hash, "registered");
  assert.match(state.events[0].message, /failed-create.*Insufficient balance/);
  assert.equal(retireFailedCreate(state), false);
});

test("comma-separated scenarios stay in one ordered target list", () => {
  assert.deepEqual(parseScenarioTarget("A2,A3,A4"), ["A2", "A3", "A4"]);
  assert.deepEqual(parseScenarioTarget("A2, A3"), ["A2", "A3"]);
  assert.deepEqual(parseScenarioTarget("wave1"), SCENARIOS);
  assert.throws(() => parseScenarioTarget("A2,A2"), /duplicates/);
  assert.throws(() => parseScenarioTarget("A2,invalid"), /Unknown scenario/);
});

test("resolve_market receipt is attributed to its trigger transaction", () => {
  const rpc = {
    receipts: [
      {
        receipt_id: "resolve-receipt",
        receiver_id: "v3.noamarket.testnet",
        predecessor_id: "ai-resolver.noamarket.testnet",
        receipt: {
          Action: {
            actions: [{ FunctionCall: { method_name: "resolve_market" } }],
          },
        },
      },
    ],
  };
  assert.deepEqual(findResolveMarketReceipts(rpc), ["resolve-receipt"]);
  const explorer = {
    data: {
      receipts: [
        {
          receipt_id: "resolve-receipt",
          receiver_account_id: "v3.noamarket.testnet",
          predecessor_account_id: "ai-resolver.noamarket.testnet",
          actions: [{ method: "resolve_market" }],
        },
      ],
    },
  };
  assert.deepEqual(findResolveMarketReceipts(explorer), ["resolve-receipt"]);
});

test("NEAR deposits use 24 decimal yocto units", () => {
  assert.equal(yocto("0.01"), "10000000000000000000000");
  assert.equal(yocto("0.1"), "100000000000000000000000");
  assert.equal(decimalUnits("1000").toString(), "1000000000000000000000");
});

test("every scenario builds a canonical v1 spec with valid core fields", () => {
  for (const scenario of SCENARIOS) {
    const spec = buildSpec({
      scenario,
      now,
      price: "100.12345678",
      balance: "10000000000000000000000",
    });
    const { specJson, specHash } = canonicalSpec(spec);
    assert.equal(spec.version, 1);
    assert.match(specHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(specJson).outcomes, spec.outcomes);
    assert.ok(Date.parse(spec.observation.at) > now.getTime() + 5 * 60_000);
    assert.equal(spec.on_unavailable, "void");
    assert.equal(spec.retry.max_attempts, 3);
    assert.ok(spec.sources.length >= 1);
  }
});

test("scenario builders carry the resolver-specific constraints", () => {
  const a3 = buildSpec({ scenario: "A3", now, price: "100" });
  assert.equal(a3.decide.kind, "change");
  assert.ok(
    Date.parse(a3.observation.baseline_at) < Date.parse(a3.observation.at),
  );
  assert.equal(a3.sources.length, 2);

  const a4 = buildSpec({
    scenario: "A4",
    now,
    balance: "10000000000000000000000",
  });
  assert.equal(a4.decide.value, "10500");
  assert.equal(a4.sources[0].extract.decimals, 18);
  assert.ok(a4.sources[0].params.rpcs.length >= 2);

  const a6 = buildSpec({
    scenario: "A6",
    now,
    fixtureUrl: "https://example.org/score.json",
  });
  assert.deepEqual(a6.sources[0].expect.assert, ["$.id == 'noa-test-1'"]);
  assert.equal(a6.sources[0].extract.path, "$.score");

  const a8n = buildSpec({
    scenario: "A8n",
    now,
    fixtureUrl: "https://example.org/feed.xml",
  });
  assert.equal(a8n.decide.default_if_no_evidence, "no");
  assert.equal(a8n.sources[0].tool, "rss_feed");
});

test("bucket edges and equality follow lower-inclusive buckets", () => {
  const edges = bucketEdges("100.12345678");
  assert.deepEqual(edges, ["100.0233333232", "100.2235802367"]);
  assert.equal(bucketOutcome("100.02", edges), "Below");
  assert.equal(bucketOutcome(edges[0], edges), "Flat");
  assert.equal(bucketOutcome(edges[1], edges), "Above");
});

test("price decision functions classify fixture candle closes", () => {
  assert.equal(thresholdOutcome("3.40", "3.40"), "Yes");
  assert.equal(thresholdOutcome("3.3999", "3.40"), "No");
  assert.equal(changeOutcome("100.1", "100"), "Up");
  assert.equal(changeOutcome("99.9", "100"), "Down");
  assert.equal(changeOutcome("100", "100.0"), "Tie");
});

test("row includes evidence links and honest TEE flag", () => {
  const state = {
    scenario: "A1",
    startedAt: "2026-11-12T19:00:05Z",
    marketId: 42,
    durationMinutes: 10,
    effectiveDurationMinutes: 6,
    specHash: "sha256:" + "a".repeat(64),
    txs: {
      create_market: {
        hash: "abc123456789",
        signer: "user1",
        receiver: "noa",
        method: "create_market",
      },
      fallback_link_market_0: {
        hash: "link123456789",
        signer: "user1",
        receiver: "court",
        method: "link_market",
      },
    },
    keeper: { trigger: ["def987654321"] },
    resolveReceipts: [
      { triggerTx: "def987654321", receiptId: "resolve-receipt" },
    ],
    fallbacks: [],
    events: [],
    verdictRecord: {
      tee: false,
      verdict: { status: "resolved", outcome_index: 0 },
    },
    independent: { summary: "3.41 => Yes" },
    pass: true,
    spec: { outcomes: ["Yes", "No"] },
  } as unknown as RunState;
  const row = formatRow(state);
  assert.match(row, /testnet\.nearblocks\.io\/txns\/abc123456789/);
  assert.match(row, /testnet\.nearblocks\.io\/txns\/link123456789/);
  assert.match(row, /testnet\.nearblocks\.io\/txns\/def987654321/);
  assert.match(
    row,
    /\[def987654\]\(https:\/\/testnet\.nearblocks\.io\/txns\/def987654321\) \(in trigger tx\)/,
  );
  assert.match(row, /\| false \| 3\.41 => Yes \| PASS \|/);
  assert.match(row, /duration: 6m \(planned 10m\)/);
});

test("result rows stay in the first table ahead of later sections", () => {
  const original = [
    "# Results",
    "",
    "| Date (UTC) | Scenario | Market ID |",
    "| --- | --- | ---: |",
    "| yesterday | A1 | 41 |",
    "",
    "## MCP connector smoke (task 3.3)",
    "Existing text must remain here.",
    "",
  ].join("\n");
  const inserted = insertResultRow(original, "| today | A2 | 42 |\n", "A2", 42);
  assert.equal(
    inserted,
    original.replace(
      "| yesterday | A1 | 41 |\n",
      "| yesterday | A1 | 41 |\n| today | A2 | 42 |\n",
    ),
  );
  const replaced = insertResultRow(
    inserted,
    "| updated | A2 | 42 |\n",
    "A2",
    42,
  );
  assert.equal(
    replaced,
    inserted.replace("| today | A2 | 42 |", "| updated | A2 | 42 |"),
  );
});

test("unknown transactions rebroadcast identical bytes, and only invalid unknown transactions re-sign", () => {
  assert.equal(
    classifyTxStatus(undefined, new Error("UNKNOWN_TRANSACTION")),
    "unknown",
  );
  assert.equal(
    classifyTxStatus({ final_execution_status: "EXECUTED_OPTIMISTIC" }),
    "confirmed",
  );
  assert.equal(
    classifyTxStatus({ final_execution_status: "FINAL" }),
    "confirmed",
  );
  assert.equal(
    classifyTxStatus({ status: { Failure: { ActionError: {} } } }),
    "failed",
  );
  assert.equal(
    retryDecision({
      status: "unknown",
      elapsedMs: 1_000,
      sinceBroadcastMs: 9_999,
    }),
    "poll",
  );
  assert.equal(
    retryDecision({
      status: "unknown",
      elapsedMs: 11_000,
      sinceBroadcastMs: 10_000,
    }),
    "rebroadcast",
  );
  assert.equal(
    retryDecision({
      status: "unknown",
      elapsedMs: 11_000,
      sinceBroadcastMs: 10_000,
      invalidBroadcast: "expired",
      allRpcsUnknown: true,
    }),
    "resign",
  );
  assert.equal(
    retryDecision({
      status: "unknown",
      elapsedMs: 11_000,
      sinceBroadcastMs: 10_000,
      invalidBroadcast: "invalid_nonce",
      allRpcsUnknown: false,
    }),
    "rebroadcast",
  );
  assert.equal(
    retryDecision({
      status: "unknown",
      elapsedMs: 300_000,
      sinceBroadcastMs: 10_000,
    }),
    "timeout",
  );
});

test("effective market duration leaves 45 seconds and never exceeds the plan", () => {
  const nowMs = Date.parse("2026-11-12T20:00:00Z");
  const at = (minutes: number, seconds = 0) =>
    new Date(nowMs + minutes * 60_000 + seconds * 1000).toISOString();
  assert.equal(effectiveMarketDurationMinutes(10, at(11), nowMs), 10);
  assert.equal(effectiveMarketDurationMinutes(10, at(7, 45), nowMs), 7);
  assert.equal(effectiveMarketDurationMinutes(10, at(5, 45), nowMs), 5);
  assert.equal(effectiveMarketDurationMinutes(10, at(5, 44), nowMs), 4);
  assert.ok(
    Date.parse(observationTime(new Date(nowMs + 5_000), 10)) >=
      nowMs + 13 * 60_000,
  );
});
