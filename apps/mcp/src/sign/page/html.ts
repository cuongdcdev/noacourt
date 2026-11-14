// Cache-buster: Cloudflare forces a 4h browser TTL on /public, so each server start gets new asset URLs.
const ASSET_VERSION = Date.now().toString(36);
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

export function signPage(
  id: string,
  status: "pending" | "completed" | "expired" | "not found",
  title = "Noa Court market",
) {
  const canSign = status === "pending";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#faf6f1"><title>${escapeHtml(title)} · Noa Court</title><script>(function(){try{var t=localStorage.getItem("noacourt-theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()</script><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/public/icon.png"><link rel="apple-touch-icon" href="/public/apple-icon.png"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"><link rel="stylesheet" href="/public/page.css?v=${ASSET_VERSION}"></head><body><main><header class="site-header"><img src="/public/noa-head.png" alt="" width="44" height="44"><div class="brand"><span class="wordmark">Noa Court</span><span class="sub">AI resolver · testnet</span></div><button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle light/dark theme" title="Toggle light/dark theme"><svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg></button></header><section class="card"><h1>${escapeHtml(title)}</h1><p class="tagline">Noa never holds your keys.</p><span id="state">${escapeHtml(status)}</span><div id="banner"></div><div id="details" class="facts"></div>${canSign ? '<button id="sign-button" type="button">Connect wallet and sign</button>' : ""}<div id="result"></div><img id="qr" alt="Open this sign link on a phone" hidden><div id="publication"></div></section><section class="card doc" id="description-card" hidden><h2>Description</h2><pre id="description"></pre></section><section class="card doc" id="rules-card" hidden><h2 id="rules-title">Rules</h2><pre id="rules"></pre></section></main><script type="module" src="/public/sign.js?v=${ASSET_VERSION}" data-request-id="${escapeHtml(id)}"></script></body></html>`;
}
