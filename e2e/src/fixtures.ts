import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UA, type Scenario } from "./constants.js";

const exec = promisify(execFile);
const fixtureDir = resolve(import.meta.dirname, "../../fixtures");

async function gh(args: string[]): Promise<string> {
  const result = await exec("gh", args, { maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

export type Fixture = {
  id: string;
  url: string;
  filename: string;
  createdAt: string;
  mutatedAt?: string;
  deletedAt?: string;
};

async function withFile<T>(
  name: string,
  contents: string,
  work: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "noacourt-fixture-"));
  const path = join(dir, name);
  try {
    await writeFile(path, contents);
    return await work(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function createFixture(scenario: Scenario): Promise<Fixture> {
  const template =
    scenario === "A6"
      ? "a6-original.json"
      : scenario === "A7"
        ? "a7-original.json"
        : "a8-base.xml";
  const filename = template.endsWith(".json") ? "score.json" : "feed.xml";
  const contents = await readFile(join(fixtureDir, template), "utf8");
  const gistUrl = await withFile(filename, contents, (path) =>
    gh([
      "gist",
      "create",
      path,
      "-d",
      `Noa Court ${scenario} ${new Date().toISOString()}`,
    ]),
  );
  const id = gistUrl.split("/").at(-1);
  if (!id || !/^[a-f0-9]+$/i.test(id))
    throw new Error(`Unexpected gist create response: ${gistUrl}`);
  const raw = JSON.parse(
    await gh(["api", "-H", `User-Agent: ${UA}`, `gists/${id}`]),
  ) as {
    owner?: { login?: string };
    files: Record<string, { raw_url: string }>;
  };
  const owner = raw.owner?.login;
  if (!owner || !raw.files[filename]?.raw_url)
    throw new Error("Gist has no owner or raw URL");
  // Omit the revision segment: versioned raw_url values stay frozen after edit.
  const url = `https://gist.githubusercontent.com/${owner}/${id}/raw/${filename}`;
  return { id, url, filename, createdAt: new Date().toISOString() };
}

export async function mutateFixture(
  scenario: Scenario,
  fixture: Fixture,
): Promise<Fixture> {
  if (scenario === "A7") {
    try {
      await gh(["gist", "delete", fixture.id, "--yes"]);
    } catch (error) {
      if (!/not found|404/i.test(String(error))) throw error;
    }
    return { ...fixture, deletedAt: new Date().toISOString() };
  }
  const template =
    scenario === "A6"
      ? "a6-mutated.json"
      : scenario === "A9"
        ? "a9-injection-post.xml"
        : "a8-post.xml";
  let contents = await readFile(join(fixtureDir, template), "utf8");
  contents = contents.replace("{{PUB_DATE}}", new Date().toUTCString());
  await withFile(fixture.filename, contents, (path) =>
    gh(["gist", "edit", fixture.id, "-f", fixture.filename, path]),
  );
  return { ...fixture, mutatedAt: new Date().toISOString() };
}

export async function publishStaticFixtures(): Promise<void> {
  const entries: Record<string, Fixture> = {};
  for (const scenario of ["A6", "A7", "A8", "A9"] as const)
    entries[scenario] = await createFixture(scenario);
  await writeFile(
    join(fixtureDir, "gists.json"),
    JSON.stringify(entries, null, 2) + "\n",
  );
  await writeFile(
    join(fixtureDir, "README.md"),
    [
      "# Noa Court fixture gists",
      "",
      "These are secret, URL-accessible template gists. Live runs create fresh per-run copies before market creation.",
      "",
      ...Object.entries(entries).map(
        ([name, value]) => `- ${name}: ${value.url} (gist ${value.id})`,
      ),
      "",
    ].join("\n"),
  );
}
