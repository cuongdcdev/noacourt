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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Noa Court</title><link rel="stylesheet" href="/public/sign.css"><style>
  :root{font-family:system-ui,sans-serif;color:#172033;background:#f5f7fb}body{margin:0}main{max-width:720px;margin:0 auto;padding:24px 16px 64px}article{background:white;border:1px solid #d9e0eb;border-radius:16px;padding:24px;box-shadow:0 8px 30px #1720330a}h1{line-height:1.2}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7fb;padding:16px;border-radius:8px}button{background:#2056db;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:1rem;cursor:pointer}button:disabled{opacity:.5;cursor:wait}#qr{width:180px;height:180px}#result a{overflow-wrap:anywhere}small{color:#526078}.error{color:#ad2635}.banner{background:#fff4e5;border:1px solid #f0c27b;border-radius:8px;padding:10px 14px;margin:12px 0}.banner.bad{background:#fdecee;border-color:#e59aa3}#publication{margin:16px 0;padding:12px 14px;border:1px solid #d9e0eb;border-radius:8px}@media(max-width:480px){article{padding:18px}main{padding:12px}}
  </style></head><body><main><article><small>Noa Court · testnet</small><h1>${escapeHtml(title)}</h1><p>Noa never holds your keys.</p><p id="state">${escapeHtml(status)}</p><div id="banner"></div><div id="details"></div>${canSign ? '<button id="sign-button" type="button">Connect wallet and sign</button>' : ""}<div id="result"></div><img id="qr" alt="Open this sign link on a phone" hidden><div id="publication"></div><h2>Description</h2><pre id="description"></pre><h2>Rules</h2><pre id="rules"></pre></article></main><script type="module" src="/public/sign.js" data-request-id="${escapeHtml(id)}"></script></body></html>`;
}
