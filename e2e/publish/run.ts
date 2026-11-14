// "Stub wallet" E2E for Noa metadata publication.
//
//   tsx e2e/publish/run.ts <sign-request-id> <creator-key-file> [--mcp http://localhost:3310]
//
// <creator-key-file> is e.g. ~/.near-credentials/testnet/<acct>.json; it is read in-process
// and never printed. The sign request must already be `completed` (creation tx verified).
// Flow: GET /api/sign/:id -> NEP-413 login -> POST /v1/markets -> POST .../publication/verify.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { keySigner } from "../../apps/mcp/src/sign/nep413.ts";
import {
  recoverPublication,
  type PublishState,
} from "../../apps/mcp/src/sign/page/noaPublish.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const mcp = (flag("--mcp") ?? "http://localhost:3310").replace(/\/$/, "");
const [requestId, keyFileArg] = args;
if (!requestId || !keyFileArg) {
  console.error(
    "usage: run.ts <sign-request-id> <creator-key-file> [--mcp URL]",
  );
  process.exit(2);
}
const keyFile = keyFileArg.replace(/^~(?=\/)/, homedir());
const parsed = JSON.parse(readFileSync(keyFile, "utf8")) as {
  account_id?: string;
  private_key?: string;
  secret_key?: string;
};
const secret = parsed.private_key ?? parsed.secret_key;
if (!secret) throw new Error("key file has no private_key");

const request = (await (
  await fetch(`${mcp}/api/sign/${requestId}`)
).json()) as any;
const view = request.publication;
console.log(
  `request ${requestId}: status=${request.status} publication=${view?.state} config=${view?.config_status}`,
);
if (request.status !== "completed" || !view?.payload || !view.noa)
  throw new Error("request is not completed with publication enabled");
// near-cli key files are named <account>.json and often lack account_id.
const accountId =
  parsed.account_id ?? basename(keyFile).replace(/\.json$/, "");
if (accountId !== view.creator)
  throw new Error(
    `key file account ${accountId} is not the verified creator ${view.creator}`,
  );

const post = async (path: string, body?: unknown) => {
  const response = await fetch(
    `${mcp}/api/sign/${requestId}/publication/${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
  );
  const json = (await response.json()) as any;
  if (!response.ok)
    throw new Error(`${path} -> HTTP ${response.status}: ${json.error}`);
  return json;
};
const result = await recoverPublication(
  { fetch, signMessage: keySigner(accountId, secret) },
  {
    apiUrl: view.noa.api_url,
    recipient: view.noa.auth_recipient,
    creator: view.creator,
    payload: view.payload,
    verify: () => post("verify"),
    report: async (state: PublishState, code) => {
      console.log(`  state -> ${state}${code ? ` (${code})` : ""}`);
      await post("report", { state, error_code: code });
    },
  },
);
const final = await post("verify");
console.log(
  `result: ${result.state}; server verified=${final.verified}; stored=${final.publication.state}`,
);
if (final.publication.market_url)
  console.log(`market: ${final.publication.market_url}`);
process.exit(final.verified ? 0 : 1);
