import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UA, type Scenario } from "./constants.js";

const templates = resolve(import.meta.dirname, "../../fixtures");
const servedDir = resolve(
  process.env.E2E_FIXTURE_DIR ??
    resolve(import.meta.dirname, "../../apps/mcp/data/fixtures"),
);
const baseUrl =
  process.env.E2E_FIXTURE_BASE_URL ??
  "https://noacourtmcp.junstudio.xyz/fixtures";
const validName = /^[a-z0-9._-]+\.(?:json|xml|rss|html|txt)$/;

export type FixtureCheck = {
  action: "created" | "mutated" | "deleted";
  at: string;
  status: number;
  matched: boolean;
  sha256?: string;
  cacheControl?: string | null;
};

export type Fixture = {
  url: string;
  filename: string;
  createdAt: string;
  mutatedAt?: string;
  deletedAt?: string;
  checks: FixtureCheck[];
};

export function fixtureName(
  scenario: Scenario,
  at: Date,
  nonce: string,
): string {
  if (!/^[a-f0-9]{8}$/.test(nonce)) throw new Error("Invalid fixture nonce");
  const stamp = at.toISOString().toLowerCase().replace(/[-:.]/g, "");
  const extension = scenario === "A6" || scenario === "A7" ? "json" : "xml";
  return `e2e-${scenario.toLowerCase()}-${stamp}-${nonce}.${extension}`;
}

export function fixtureUrl(filename: string, base = baseUrl): string {
  if (!validName.test(filename))
    throw new Error(`Invalid fixture name: ${filename}`);
  return new URL(filename, `${base.replace(/\/+$/, "")}/`).toString();
}

function fixturePath(filename: string): string {
  fixtureUrl(filename);
  return join(servedDir, filename);
}

async function atomicWrite(filename: string, contents: string): Promise<void> {
  await mkdir(servedDir, { recursive: true });
  const temp = join(
    servedDir,
    `.${filename}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temp, contents);
    await rename(temp, fixturePath(filename));
  } finally {
    await unlink(temp).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function verifyServed(
  filename: string,
  expected: string | null,
  action: FixtureCheck["action"],
): Promise<FixtureCheck> {
  const url = fixtureUrl(filename);
  const bytes = expected === null ? null : Buffer.from(expected);
  let last = "no response";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": UA, "cache-control": "no-cache" },
        signal: AbortSignal.timeout(10_000),
      });
      const received = Buffer.from(await response.arrayBuffer());
      const matched =
        bytes === null
          ? response.status === 404
          : response.status === 200 && received.equals(bytes);
      if (matched)
        return {
          action,
          at: new Date().toISOString(),
          status: response.status,
          matched,
          ...(bytes
            ? { sha256: createHash("sha256").update(bytes).digest("hex") }
            : {}),
          cacheControl: response.headers.get("cache-control"),
        };
      last = `HTTP ${response.status}; served bytes did not match`;
    } catch (error) {
      last = String(error);
    }
    if (attempt < 4)
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error(`Fixture ${url} verification failed: ${last}`);
}

function originalTemplate(scenario: Scenario): string {
  if (scenario === "A6") return "a6-original.json";
  if (scenario === "A7") return "a7-original.json";
  if (scenario === "A8n") return "a8n-no-post.xml";
  return "a8-base.xml";
}

export async function createFixture(
  scenario: Scenario,
  at = new Date(),
): Promise<Fixture> {
  const filename = fixtureName(scenario, at, randomBytes(4).toString("hex"));
  const contents = await readFile(
    join(templates, originalTemplate(scenario)),
    "utf8",
  );
  await atomicWrite(filename, contents);
  try {
    const check = await verifyServed(filename, contents, "created");
    return {
      url: fixtureUrl(filename),
      filename,
      createdAt: check.at,
      checks: [check],
    };
  } catch (error) {
    await unlink(fixturePath(filename)).catch(() => {});
    throw error;
  }
}

export async function removeFixture(fixture: Fixture): Promise<void> {
  await unlink(fixturePath(fixture.filename)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

export async function mutateFixture(
  scenario: Scenario,
  fixture: Fixture,
): Promise<Fixture> {
  if (scenario === "A7") {
    await unlink(fixturePath(fixture.filename)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const check = await verifyServed(fixture.filename, null, "deleted");
    return {
      ...fixture,
      deletedAt: check.at,
      checks: [...(fixture.checks ?? []), check],
    };
  }
  const template =
    scenario === "A6"
      ? "a6-mutated.json"
      : scenario === "A9"
        ? "a9-injection-post.xml"
        : "a8-post.xml";
  const contents = (await readFile(join(templates, template), "utf8")).replace(
    "{{PUB_DATE}}",
    new Date().toUTCString(),
  );
  await atomicWrite(fixture.filename, contents);
  const check = await verifyServed(fixture.filename, contents, "mutated");
  return {
    ...fixture,
    mutatedAt: check.at,
    checks: [...(fixture.checks ?? []), check],
  };
}

export async function publishStaticFixtures(): Promise<void> {
  const entries: Record<string, string> = {};
  for (const scenario of ["A6", "A7", "A8", "A8n", "A9"] as const) {
    const filename = `noacourt-${scenario.toLowerCase()}.${scenario === "A6" || scenario === "A7" ? "json" : "xml"}`;
    const contents = await readFile(
      join(templates, originalTemplate(scenario)),
      "utf8",
    );
    await atomicWrite(filename, contents);
    await verifyServed(filename, contents, "created");
    entries[scenario] = fixtureUrl(filename);
  }
  await writeFile(
    join(templates, "urls.json"),
    JSON.stringify(entries, null, 2) + "\n",
  );
  await writeFile(
    join(templates, "README.md"),
    [
      "# E2E fixture templates",
      "",
      "The fixture service serves files from `apps/mcp/data/fixtures/` with `Cache-Control: no-store`.",
      "Run `cd e2e && pnpm e2e fixtures` to copy stable templates and update `fixtures/urls.json`.",
      "Live A6/A7/A8/A8n/A9 runs create unique files and verify their served bytes over HTTPS.",
      "A6 rewrites its identity, A7 deletes its file, A8 and A9 rewrite their RSS feeds, and A8n leaves its old item unchanged.",
      "Sources from this service receive the expected `self_declared` label.",
      "Gists were dropped because the gh token lacks Gists permission.",
      "",
      ...Object.entries(entries).map(([name, url]) => `- ${name}: ${url}`),
      "",
    ].join("\n"),
  );
}
