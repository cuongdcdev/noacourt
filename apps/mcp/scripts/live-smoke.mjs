import { loadConfig } from "../dist/config.js";
import { createApp } from "../dist/server.js";
import { examples } from "../dist/guide.js";

const config = { ...loadConfig(), keeperEnabled: false };
const instance = createApp(config);
const server = await new Promise((resolve) => {
  const started = instance.app.listen(0, "127.0.0.1", () => resolve(started));
});
const base = `http://127.0.0.1:${server.address().port}`;
const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
let sequence = 0;
async function tool(name, args) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++sequence,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  if (!response.ok || body.error || body.result?.isError)
    throw new Error(
      `${name}: ${body.error?.message || body.result?.content?.[0]?.text || response.status}`,
    );
  return JSON.parse(body.result.content[0].text);
}
const summary = (verdict) => ({
  mode: verdict?.mode,
  status: verdict?.status,
  value: verdict?.value,
  outcome: verdict?.outcome,
  reason: verdict?.reason,
  sources: verdict?.sources?.map((source) => ({
    id: source.id,
    value: source.value,
    error: source.error,
  })),
});
try {
  console.log("port", server.address().port);
  const health = await (await fetch(`${base}/healthz`, { headers })).json();
  console.log(
    "health",
    JSON.stringify({
      wasm: health.wasm,
      court_resolver_note: health.court_resolver_note,
    }),
  );
  const lint = await tool("spec_lint", { spec: examples.A1 });
  console.log(
    "A1 lint",
    JSON.stringify({
      ok: lint.ok,
      errors: lint.errors,
      labels: lint.labels,
      matches_court_resolver: lint.matches_court_resolver,
      court_resolver_note: lint.court_resolver_note,
    }),
  );
  const simulated = await tool("spec_simulate", { spec: examples.A1 });
  console.log("A1 simulate", JSON.stringify(summary(simulated.verdict)));
  const binance = await tool("source_sample", {
    source: {
      id: "binance",
      tool: "binance_kline",
      params: { symbol: "NEARUSDT", interval: "1m" },
    },
  });
  console.log(
    "Binance sample",
    JSON.stringify({ source: binance.source, fallback: binance.fallback }),
  );
  const github = await tool("source_sample", {
    source: {
      id: "nearcore",
      tool: "http_json",
      request: {
        method: "GET",
        url: "https://api.github.com/repos/near/nearcore",
      },
      expect: { status: 200, assert: ['$.full_name == "near/nearcore"'] },
      identity: "asserted",
      extract: { path: "$.stargazers_count", type: "int", decimals: 0 },
    },
  });
  console.log(
    "GitHub http_json sample",
    JSON.stringify({
      source: github.source,
      suggested_asserts: github.raw?.identity_asserts?.slice(0, 5),
      paths: github.raw?.candidate_extract_paths?.slice(0, 5),
    }),
  );
  const link = await tool("market_create_link", {
    title: "PLACEHOLDER smoke: NEAR 1m close threshold",
    outcomes: ["Yes", "No"],
    stake: "10",
    duration_minutes: 10,
    spec: examples.A1,
  });
  const id = link.url.split("/").at(-1);
  console.log(
    "create link",
    JSON.stringify({
      id,
      expires_at: link.expires_at,
      spec_hash: link.spec_hash,
      qr_png: link.qr_png_data_url.startsWith("data:image/png;base64,"),
    }),
  );
  const planResponse = await fetch(
    `${base}/api/sign/${id}/plan?account=user1.noamarket.testnet`,
    { headers },
  );
  const plan = await planResponse.json();
  if (!planResponse.ok)
    throw new Error(`plan: ${plan.error || planResponse.status}`);
  console.log(
    "sign plan",
    JSON.stringify({
      account_id: plan.account_id,
      note: plan.note,
      tx_plan: plan.tx_plan.map((tx) => ({
        receiverId: tx.receiverId,
        signerId: tx.signerId,
        method: tx.actions[0].params.methodName,
        args: {
          ...tx.actions[0].params.args,
          spec_json: tx.actions[0].params.args.spec_json
            ? `${tx.actions[0].params.args.spec_json.slice(0, 100)}…`
            : undefined,
        },
        gas: tx.actions[0].params.gas,
        deposit: tx.actions[0].params.deposit,
      })),
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  instance.close();
}
