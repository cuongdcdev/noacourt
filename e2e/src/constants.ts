export const COURT = "ai-resolver.noamarket.testnet";
export const NOA = "v3.noamarket.testnet";
export const TOKEN = "point.noamarket.testnet";
export const USER = (n: number) => `user${n}.noamarket.testnet`;
export const RPC_URLS = (
  process.env.NEAR_RPC_URLS ||
  [
    "https://test.rpc.fastnear.com",
    "https://rpc.testnet.near.org",
    "https://archival-rpc.testnet.near.org",
  ].join(",")
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
export const SCENARIOS = [
  "A1",
  "A2",
  "A3",
  "A4",
  "A6",
  "A7",
  "A8",
  "A8n",
  "A9",
  "NEGW",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
export function parseDurationMinutes(value: string): number {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 5
  )
    throw new Error("--duration requires an integer of at least 5 minutes");
  return Number(value);
}
export function parseScenarioTarget(target: string | undefined): Scenario[] {
  if (target === "all" || target === "wave1") return [...SCENARIOS];
  const names = target?.split(",").map((name) => name.trim()) ?? [];
  if (
    !names.length ||
    names.some((name) => !SCENARIOS.includes(name as Scenario))
  )
    throw new Error(`Unknown scenario target: ${target ?? "(missing)"}`);
  if (new Set(names).size !== names.length)
    throw new Error("Scenario list contains duplicates");
  return names as Scenario[];
}
export const isText = (scenario: Scenario) =>
  ["A8", "A8n", "A9"].includes(scenario);
export const isFailure = (scenario: Scenario) =>
  ["A6", "A7"].includes(scenario);
