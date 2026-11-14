import { explorerBase } from "../../config.js";
import { sourcePhrase, renderNoaRules } from "../../spec/noaRules.js";
import { renderRules } from "../../spec/render.js";
import { DEFAULT_RETRY_POLICY } from "../../spec/defaults.js";
import { sourceLabel } from "../../catalog.js";

const ASSET_VERSION = Date.now().toString(36);
function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}
const row = (label: string, value: string) =>
  `<div class="row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

const TITLE_ICON =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h8M8 17h8"/></svg>';

function head(title: string, network: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#faf6f1"><meta name="robots" content="noindex"><title>${esc(title)} · Noa Court</title><script>(function(){try{var t=localStorage.getItem("noacourt-theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()</script><link rel="icon" href="/favicon.ico?v=${ASSET_VERSION}" sizes="any"><link rel="icon" type="image/png" href="/public/icon.png?v=${ASSET_VERSION}"><link rel="apple-touch-icon" href="/public/apple-icon.png?v=${ASSET_VERSION}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"><link rel="stylesheet" href="/public/page.css?v=${ASSET_VERSION}"></head><body><main><header class="top"><img src="/public/noa-head.png" alt="" width="40" height="40"><div class="brand"><span class="wordmark">Noa Court</span><span class="sub">AI resolver on OutLayer · ${esc(network)}</span></div><button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle light/dark theme" title="Toggle light/dark theme"><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg></button></header>`;
}
const TOGGLE_SCRIPT = `<script>(function(){var r=document.documentElement,b=document.getElementById("theme-toggle");if(b)b.addEventListener("click",function(){var d=!r.classList.contains("dark");r.classList.toggle("dark",d);try{localStorage.setItem("noacourt-theme",d?"dark":"light")}catch(e){}})})()</script>`;

export function specNotFoundPage(
  network: string,
  message = "No spec with this hash is registered on the Court contract.",
) {
  return `${head("Spec not found", network)}<section class="mhead"><h1>Spec not found</h1><p class="status" role="status" data-tone="bad">${esc(message)}</p></section></main>${TOGGLE_SCRIPT}</body></html>`;
}

export function specPage(input: {
  hex: string;
  spec_json: string;
  source: "chain" | "local";
  network: string;
  courtContract: string;
  registeredBy?: string | null;
}) {
  const spec = JSON.parse(input.spec_json) as Record<string, any>;
  const rendered = renderRules(input.spec_json);
  const explorer = explorerBase(input.network);
  const outcomes: string[] = spec.outcomes ?? [];
  const retry = { ...DEFAULT_RETRY_POLICY, ...(spec.retry ?? {}) };
  const decide = spec.decide ?? {};
  const decision =
    decide.kind === "threshold"
      ? `Threshold: yes if value ${esc(decide.op)} ${esc(decide.value)}`
      : decide.kind === "buckets"
        ? `Buckets with edges ${esc((decide.edges ?? []).join(", "))} (an edge value falls in the higher bucket)`
        : decide.kind === "text_judge"
          ? `Three AI jurors must agree: ${esc(decide.question)}`
          : esc(decide.kind);
  const sources = (spec.sources ?? [])
    .map(
      (source: Record<string, any>) =>
        `<li>${esc(sourcePhrase(source))} <span class="dim">· ${esc(source.id)} · ${esc(sourceLabel(source))}</span></li>`,
    )
    .join("");
  const unavailable =
    spec.on_unavailable === "void"
      ? "Void: the market is voided and all bets are refunded."
      : `Resolves ${esc(spec.on_unavailable)}`;
  const contractLink = `<a class="mono" href="${explorer}/address/${encodeURIComponent(input.courtContract)}" target="_blank" rel="noopener noreferrer">${esc(input.courtContract)}</a> <span class="badge">TEE</span>`;
  const origin =
    input.source === "chain"
      ? "Read from the Court contract on-chain (source of truth)."
      : "The Court contract could not be read just now; showing this server's stored copy. Check the hash against the contract.";
  const title = spec.question || "Resolution rules";
  return `${head(String(title), input.network)}<section class="mhead"><div class="mtitle"><h1>${esc(title)}</h1></div><div class="meta"><span class="pill" data-phase="${input.source === "chain" ? "created" : "draft"}"><i aria-hidden="true"></i><span>${input.source === "chain" ? "On-chain spec" : "Local copy"}</span></span></div><p class="status" role="status" data-tone="${input.source === "chain" ? "ok" : "busy"}" id="origin" data-source="${input.source}">${esc(origin)}</p></section><div class="layout"><div class="content"><section class="card" aria-labelledby="outcomes-h"><h2 class="eyebrow" id="outcomes-h">Outcomes</h2><ul class="outcomes">${outcomes.map((o) => `<li>${esc(o)}</li>`).join("")}</ul></section><section class="card" aria-labelledby="rr-h"><h2 class="ctitle" id="rr-h">${TITLE_ICON}Resolution rules</h2><h3 class="eyebrow noa-label">Plain-language summary</h3><pre class="noa-rules">${esc(renderNoaRules(input.spec_json))}</pre><dl class="rows foot">${row("Observed at", `<time>${esc(spec.observation?.at)}</time> <span class="dim">· ${esc(spec.observation?.mode)}${spec.observation?.max_delay ? `, max delay ${esc(spec.observation.max_delay)}` : ""}</span>`)}${row("Sources", `<ul class="srclist">${sources}</ul>`)}${row("Aggregate", `${esc(spec.aggregate?.method)}${spec.aggregate?.tolerance ? ` <span class="dim">· tolerance ${esc(spec.aggregate.tolerance)}</span>` : ""}`)}${row("Decision", decision)}${row("Retry", `Up to ${esc(retry.max_attempts)} attempts, every ${esc(retry.every)}`)}${row("If unavailable", unavailable)}${row("Resolver", `${contractLink}<span class="sub2">Resolved by Noa Court in an OutLayer TEE</span>`)}${row("Spec hash", `<span class="hash"><code>sha256:${esc(input.hex)}</code></span>`)}</dl><details class="disc"><summary>Full canonical rules (binding, hashed)</summary><div class="doc"><pre class="noa-rules" id="canonical">${esc(rendered.rules_markdown)}</pre><p class="srcnote">Rules text hash: <code>${esc(rendered.rules_text_hash)}</code></p></div></details></section></div></div></main>${TOGGLE_SCRIPT}</body></html>`;
}
