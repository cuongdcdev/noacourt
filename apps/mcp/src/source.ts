import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
function privateIp(ip: string): boolean {
  if (ip.includes(":"))
    return (
      ip === "::1" ||
      ip === "::" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe8") ||
      ip.startsWith("fe9") ||
      ip.startsWith("fea") ||
      ip.startsWith("feb") ||
      ip.startsWith("::ffff:")
    );
  const parts = ip.split(".").map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 192 && parts[1] === 0) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
  );
}
export async function safeUrl(
  input: string,
  resolveHost: typeof lookup = lookup,
): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      "source_sample raw fetch requires an HTTPS URL without credentials",
    );
  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    (isIP(url.hostname) && privateIp(url.hostname))
  )
    throw new Error("source_sample rejects private or loopback addresses");
  const addresses = await resolveHost(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some((address) => privateIp(address.address))
  )
    throw new Error("source_sample rejects private or loopback addresses");
  return url;
}

export function sampleUrl(source: Record<string, any>): string | null {
  if (source.tool === "http_json")
    return source.request?.url || source.params?.request?.url || null;
  if (source.tool === "github_repo")
    return `https://api.github.com/repos/${encodeURIComponent(source.params?.owner || "")}/${encodeURIComponent(source.params?.repo || "")}`;
  return null;
}

export async function rawSample(
  source: Record<string, any>,
  request: typeof fetch = fetch,
  resolveHost: typeof lookup = lookup,
) {
  const input = sampleUrl(source);
  if (!input) return null;
  let url = await safeUrl(input, resolveHost);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 3; redirect++) {
    response = await request(url, {
      method: "GET",
      headers: { "user-agent": userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirect === 3) throw new Error("too many redirects");
      url = await safeUrl(
        new URL(response.headers.get("location") || "", url).href,
        resolveHost,
      );
      continue;
    }
    break;
  }
  if (!response?.ok)
    throw new Error(`raw source GET failed: HTTP ${response?.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("raw source response has no body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) throw new Error("raw source response exceeds 64 KB");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  const suggestions = suggestPaths(data);
  return {
    url: url.href,
    excerpt: JSON.stringify(data, null, 2).slice(0, 4096),
    suggested_repo_id:
      source.tool === "github_repo" &&
      typeof (data as Record<string, unknown>)?.id === "number"
        ? (data as Record<string, number>).id
        : null,
    ...suggestions,
  };
}

export function suggestPaths(data: unknown) {
  const identityKeys = new Set([
    "id",
    "symbol",
    "address",
    "slug",
    "full_name",
    "name",
    "contract",
    "pair",
  ]);
  const identity_asserts: string[] = [];
  const candidate_extract_paths: string[] = [];
  function walk(value: unknown, path: string, depth: number) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      depth > 2
    )
      return;
    for (const [key, child] of Object.entries(value)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      const next = `${path}.${key}`;
      if (
        identityKeys.has(key) &&
        (typeof child === "string" ||
          typeof child === "number" ||
          typeof child === "boolean")
      )
        identity_asserts.push(`${next} == ${JSON.stringify(child)}`);
      if (typeof child === "number") candidate_extract_paths.push(next);
      if (child && typeof child === "object") walk(child, next, depth + 1);
    }
  }
  walk(data, "$", 0);
  return { identity_asserts, candidate_extract_paths };
}
