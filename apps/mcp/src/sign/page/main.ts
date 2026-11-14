import "./theme.js";
import { NearConnector } from "@hot-labs/near-connect";
import { WALLET_MANIFEST } from "./manifest.js";
import { Buffer } from "buffer";
import {
  recoverPublication,
  noaLogin,
  type NoaSession,
  type PublishState,
  type PublicationErrorCode,
  type PublicationPayload,
  type ServerVerify,
} from "./noaPublish.js";

type PublicRequest = {
  id: string;
  status: string;
  params: {
    title: string;
    outcomes: string[];
    stake: string;
    token_id?: string;
    creator?: string | null;
  };
  sign_before?: string;
  requested_close_at?: string;
  rules_markdown: string;
  description?: string | null;
  metadata_digest?: string | null;
  spec_hash?: string;
  publication: PublicationView;
  qr_url: string;
  spec_summary?: {
    question?: string;
    observation?: { at?: string; mode?: string; max_delay?: string };
    sources?: { id: string; tool: string }[];
    decision_kind?: string;
    decide?: { kind?: string; op?: string; value?: string };
    outcome_map?: Record<string, string>;
  };
  resolver_sha256?: string | null;
  result?: Record<string, any>;
  network: {
    networkId: "testnet" | "mainnet";
    nodeUrl: string;
    courtContract: string;
  };
};
type PublicationView = {
  state: string;
  error: string | null;
  last_verified_at: string | null;
  config_status: "enabled" | "disabled" | "invalid";
  config_error?: string;
  market_id: number | null;
  creator: string | null;
  market_url: string | null;
  noa: { api_url: string; auth_recipient: string } | null;
  payload: PublicationPayload | null;
};
const id = (
  document.querySelector("script[data-request-id]") as HTMLScriptElement
).dataset.requestId!;
const state = document.getElementById("state")!;
const details = document.getElementById("details")!;
const result = document.getElementById("result")!;
const button = document.getElementById(
  "sign-button",
) as HTMLButtonElement | null;

type Tone = "info" | "ok" | "bad" | "busy";
// One place for status text: the element is an aria-live region, the tone only drives the dot colour.
function setStatus(text: string, tone: Tone = "info") {
  state.textContent = text;
  state.dataset.tone = tone;
}
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function term(label: string, value: Node | string, target: HTMLElement = details) {
  const row = el("div", "row");
  const dt = el("dt", undefined, label);
  const dd = el("dd");
  dd.append(value);
  row.append(dt, dd);
  target.append(row);
}
function words(values: string[]) {
  const list = el("ul", "outcomes");
  for (const value of values) list.append(el("li", undefined, value));
  return list;
}
function copyable(value: string) {
  const wrap = el("span", "hash");
  const code = el("code", undefined, value);
  const copy = el("button", "copy", "Copy");
  copy.type = "button";
  copy.setAttribute("aria-label", `Copy value ${value}`);
  copy.onclick = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      },
      () => undefined,
    );
  };
  wrap.append(code, copy);
  return wrap;
}
function formatUtc(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(+date)) return iso;
  return `${date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}
function timeNode(iso: string, hint?: boolean) {
  const frag = document.createDocumentFragment();
  const t = el("time", undefined, formatUtc(iso));
  if (!Number.isNaN(+new Date(iso))) t.dateTime = iso;
  frag.append(t);
  if (hint) {
    const ms = +new Date(iso) - Date.now();
    if (Number.isFinite(ms) && ms > 0) {
      const hours = Math.round(ms / 36e5);
      const days = Math.round(ms / 864e5);
      frag.append(
        el("span", "dim", ` · in ${hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${days} days`}`),
      );
    }
  }
  return frag;
}
function decisionLine(markdown: string) {
  return /^##\s+Decision[ \t]*\n+([^\n]+)/m.exec(markdown)?.[1]?.trim();
}

// Tiny display-only markdown: headings, bullets, line breaks, inline code. Built with
// createElement/textContent, so data is never parsed as HTML. The binding text is not altered
// (the exact source is also shown verbatim under "Show exact source text").
const INLINE = /(`[^`\n]+`|\{[^{}\n]*\}|\[[^\[\]\n]*\])/g;
const LABEL = /^([A-Za-z][A-Za-z /_()-]{0,28}):\s+(\S.*)$/;
function inline(parent: ParentNode, text: string) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) parent.append(text.slice(last, at));
    parent.append(el("code", undefined, m[0].startsWith("`") ? m[0].slice(1, -1) : m[0]));
    last = at + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
function line(parent: ParentNode, text: string) {
  const m = LABEL.exec(text);
  if (m) {
    parent.append(el("strong", "lbl", `${m[1]}:`), " ");
    inline(parent, m[2]);
  } else inline(parent, text);
}
function renderRules(root: HTMLElement, text: string) {
  root.replaceChildren();
  let para: string[] = [];
  let list: HTMLUListElement | null = null;
  let item: HTMLLIElement | null = null;
  const flush = () => {
    if (!para.length) return;
    const p = el("p");
    para.forEach((l, i) => {
      if (i) p.append(document.createElement("br"));
      line(p, l);
    });
    root.append(p);
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    const bullet = /^[-*]\s+(.*)$/.exec(raw);
    if (!raw.trim()) {
      flush();
      list = item = null;
    } else if (heading) {
      flush();
      list = item = null;
      const h = el(heading[1].length === 1 ? "h3" : "h4");
      inline(h, heading[2]);
      root.append(h);
    } else if (bullet) {
      flush();
      if (!list) root.append((list = el("ul")));
      item = el("li");
      line(item, bullet[1]);
      list.append(item);
    } else if (item && /^\s/.test(raw)) {
      const cont = el("span", "cont");
      line(cont, raw.trim());
      item.append(cont);
    } else {
      list = item = null;
      para.push(raw);
    }
  }
  flush();
}
function setDoc(textId: string, text: string | null | undefined) {
  const box = document.getElementById(textId)!;
  if (text?.trim()) renderRules(box, text);
  else box.replaceChildren();
  const card = document.getElementById(`${textId}-card`);
  if (card) card.hidden = !text?.trim();
}
function setPill(phase: string, text: string) {
  document.getElementById("pill")!.dataset.phase = phase;
  document.getElementById("pill-text")!.textContent = text;
}
let creatorNode: HTMLElement | null = null;
function setCreator(account?: string) {
  if (creatorNode) creatorNode.textContent = account || "your wallet";
  if (creatorNode) creatorNode.classList.toggle("dim", !account);
}
// Noa's palette: teal/rose for a Yes/No pair, slot colours by position otherwise.
const SLOT = ["#EF9F27", "#378ADD", "#1D9E75", "#7F77DD"];
const OPS: Record<string, string> = { ">=": "≥", ">": ">", "<=": "≤", "<": "<" };
function winText(name: string, s?: PublicRequest["spec_summary"]) {
  const map = s?.outcome_map;
  if (!map) return "";
  const keys = Object.keys(map);
  const key = keys.find((k) => map[k] === name);
  if (s?.decide?.kind === "threshold") {
    if (key === "true")
      return `if value ${OPS[s.decide.op ?? ""] ?? s.decide.op} ${s.decide.value}`;
    if (key === "false") return "otherwise";
  } else if (s?.decide?.kind === "text_judge") {
    if (key === "yes") return "if the jurors say yes";
    if (key === "no") return "otherwise";
  }
  return "";
}
function renderOutcomes(
  names: string[],
  s?: PublicRequest["spec_summary"],
) {
  const list = document.getElementById("olist")!;
  list.replaceChildren();
  const heading = document.getElementById("outcomes-h")!;
  heading.textContent = `Outcomes · ${names.length}`;
  names.forEach((name, i) => {
    const li = el("li", "orow");
    const dot = el("span", "dot");
    dot.style.background =
      names.length === 2
        ? i === 0
          ? "#1D9E75"
          : "#D4537E"
        : (SLOT[i] ?? "#888780");
    const label = el("span", "oname", name);
    li.append(dot, label);
    const win = winText(name, s);
    if (win) li.append(el("span", "owin", win));
    list.append(li);
  });
}
function showResult(data: Record<string, any>) {
  result.replaceChildren();
  const heading = el("h2", undefined, `Market #${data.market_id} created`);
  result.append(heading);
  result.append(
    el(
      "p",
      "lead",
      data.linked
        ? "Your market is live and linked to Noa Court."
        : `Your market was created. Linking it to Noa Court will be retried automatically${data.link_error ? ` (${data.link_error})` : ""}.`,
    ),
  );
  const hashes = [
    ...(data.tx_hashes || []),
    ...(data.link_tx_hash ? [data.link_tx_hash] : []),
  ];
  if (hashes.length) {
    const list = el("ul", "txs");
    for (const hash of hashes) {
      const li = el("li");
      const a = el("a", undefined, `Transaction ${hash}`);
      a.href = `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.append(a);
      list.append(li);
    }
    result.append(list);
  }
}

async function getJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(
      data.error || `HTTP ${response.status}`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return data;
}

const STATE_TEXT: Record<string, string> = {
  not_started: "The description and rules have not been published to Noa yet.",
  auth_required:
    "Sign in with your wallet to publish the description and rules to Noa.",
  publishing: "Publishing the description and rules to Noa…",
  awaiting_verification:
    "Published. Waiting for Noa to confirm it holds the exact text.",
  published: "Published on Noa and verified against the terms above.",
  retryable_error: "Publishing to Noa failed. You can retry.",
  conflict:
    "Noa already holds different text for this market, so publishing stopped. Noa metadata is write-once and cannot be overwritten.",
  legacy_unavailable:
    "This is a legacy request with no reviewed description, so nothing was published to Noa automatically.",
  disabled: "Publishing to Noa is not configured on this deployment.",
};
const publicationBox = document.getElementById("publication")!;
const banner = document.getElementById("banner")!;
let publicationButton: HTMLButtonElement | null = null;

function renderPublication(
  view: PublicationView,
  extra?: string,
  onRetry?: () => void,
) {
  publicationBox.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = "Publication on Noa";
  const text = document.createElement("p");
  text.textContent = `${STATE_TEXT[view.state] ?? view.state}${view.error ? ` (${view.error})` : ""}${extra ? ` ${extra}` : ""}`;
  if (["conflict", "retryable_error"].includes(view.state))
    text.className = "error";
  publicationBox.setAttribute("aria-live", "polite");
  publicationBox.append(heading, text);
  if (view.state === "published" && view.market_url) {
    const p = document.createElement("p");
    const a = document.createElement("a");
    a.href = view.market_url;
    a.textContent = "Open market on Noa";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    p.append(a);
    publicationBox.append(p);
  }
  if (view.last_verified_at && view.state === "published") {
    const p = document.createElement("small");
    p.textContent = `Last verified ${formatUtc(view.last_verified_at)}`;
    publicationBox.append(p);
  }
  const canRetry =
    onRetry &&
    view.payload &&
    !["published", "conflict", "legacy_unavailable", "disabled"].includes(
      view.state,
    );
  if (canRetry) {
    publicationButton = document.createElement("button");
    publicationButton.type = "button";
    publicationButton.textContent =
      view.state === "not_started"
        ? "Publish description and rules to Noa"
        : "Retry publishing to Noa";
    publicationButton.onclick = onRetry;
    publicationBox.append(publicationButton);
  }
}

function banners(view: PublicationView) {
  banner.replaceChildren();
  const add = (message: string, bad = false) => {
    const div = el("p", bad ? "banner bad" : "banner");
    div.append(el("strong", undefined, bad ? "Cannot continue. " : "Note. "), message);
    if (bad) div.setAttribute("role", "alert");
    banner.append(div);
  };
  if (view.config_status === "disabled")
    add(
      "Publishing to Noa is not set up on this deployment, so the market will be created without a Noa description or rules.",
    );
  if (view.config_status === "invalid")
    add(
      `Publishing to Noa is misconfigured on this deployment, so new markets cannot be created from it. Details: ${view.config_error}`,
      true,
    );
}

async function main() {
  let request: PublicRequest;
  try {
    request = await getJson(`/api/sign/${encodeURIComponent(id)}`);
  } catch (error) {
    details.replaceChildren();
    details.removeAttribute("aria-busy");
    document.getElementById("layout")!.classList.add("solo");
    setPill("expired", (error as Error).message.includes("expired") ? "Expired" : "Not found");
    if ((error as Error).message.includes("expired"))
      setStatus(
        "This signing link has expired. Ask your AI agent for a new one.",
        "bad",
      );
    else
      setStatus(
        "We could not find this signing request. Check the link, or ask your AI agent for a new one.",
        "bad",
      );
    button?.remove();
    return;
  }
  const statusText: Record<string, [string, Tone]> = {
    pending: [
      "Waiting for your signature. Nothing is created until you approve in your wallet.",
      "info",
    ],
    completed: ["Signed and confirmed on-chain.", "ok"],
    expired: [
      "This signing link has expired. Ask your AI agent for a new one.",
      "bad",
    ],
  };
  const [initialText, initialTone] = statusText[request.status] ?? [
    request.status,
    "info",
  ];
  setStatus(initialText, initialTone);
  let publication = request.publication;
  if (request.status === "pending") banners(publication);
  if (publication.config_status === "invalid") button?.remove();
  details.replaceChildren();
  details.removeAttribute("aria-busy");
  const summary = request.spec_summary;
  const phase: [string, string] =
    request.status === "pending"
      ? ["draft", "Draft · awaiting signature"]
      : request.status === "completed"
        ? ["created", "Created"]
        : ["expired", "Expired"];
  setPill(...phase);
  const closeAt = request.requested_close_at ?? summary?.observation?.at;
  if (closeAt) {
    const m = document.getElementById("m-close")!;
    m.lastElementChild!.textContent = `Closes ${formatUtc(closeAt)}`;
    m.hidden = false;
  }
  const token = request.params.token_id || "NPOINT";
  {
    const m = document.getElementById("m-stake")!;
    m.firstElementChild!.textContent = `${request.params.stake} ${token} stake`;
    m.hidden = false;
  }
  renderOutcomes(request.params.outcomes, summary);
  const plines = document.getElementById("plines");
  if (plines) {
    const stake = el("span");
    stake.append(
      el("strong", undefined, request.params.stake),
      el("span", "dim", ` ${token}`),
    );
    term("Stake", stake, plines);
    if (request.sign_before && request.status === "pending")
      term("Sign before", timeNode(request.sign_before, true), plines);
  }
  // Footer rows, Noa style: creator, resolver, sources, observation time.
  creatorNode = el("span");
  creatorNode.className = "mono";
  setCreator(request.params.creator ?? undefined);
  term("Creator", creatorNode);
  {
    const by = el("span", "resolver");
    const link = el("a", "mono", request.network.courtContract);
    link.href = `https://${request.network.networkId}.nearblocks.io/address/${encodeURIComponent(request.network.courtContract)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    by.append(link, " ", el("span", "badge", "TEE"));
    const sub = el("span", "sub2");
    sub.append("Noa Court on OutLayer TEE · verifiable WASM resolver");
    const h = request.resolver_sha256;
    if (h) {
      const short = h.replace(/^sha256:/, "");
      sub.append(` (sha256:${short.slice(0, 8)}…${short.slice(-4)})`);
    }
    if (summary?.decision_kind === "text_judge")
      sub.append(" + 3 NEAR AI jurors");
    by.append(sub);
    term("Resolver", by);
    (document.getElementById("how") as HTMLElement).hidden = false;
  }
  if (summary?.sources?.length)
    term("Sources", summary.sources.map((x) => x.id).join(", "));
  const observation = summary?.observation;
  if (observation?.at) {
    const wrap = el("span");
    wrap.append(timeNode(observation.at));
    const bits = [
      observation.mode,
      observation.max_delay ? `max delay ${observation.max_delay}` : "",
    ].filter(Boolean);
    if (bits.length) wrap.append(el("span", "dim", ` · ${bits.join(", ")}`));
    term("Observed at", wrap);
  }
  const verifyRows = document.getElementById("verify-rows")!;
  if (request.spec_hash)
    term("Spec hash", copyable(request.spec_hash), verifyRows);
  if (request.metadata_digest)
    term("Metadata digest", copyable(request.metadata_digest), verifyRows);
  (document.getElementById("verify") as HTMLElement).hidden =
    !verifyRows.childElementCount;
  // Display only: when the frozen description equals the rules, show the text once.
  const rawRules = document.getElementById("rules-raw")!;
  rawRules.textContent = request.rules_markdown;
  const sameText = request.description === request.rules_markdown;
  const desc = sameText
    ? null
    : (request.description ?? "(no reviewed description: legacy request)");
  setDoc("description", desc);
  document.getElementById("rules-title")!.hidden = !desc;
  setDoc("rules", request.rules_markdown);
  const qr = document.getElementById("qr") as HTMLImageElement | null;
  if (qr && request.status === "pending") {
    try {
      const qrData = await getJson(`/api/sign/${encodeURIComponent(id)}/qr`);
      qr.src = qrData.qr_png_data_url;
      qr.hidden = false;
      (document.getElementById("phone") as HTMLElement).hidden = false;
    } catch {
      /* the phone affordance is optional */
    }
  }

  const publicationEnabled = publication.config_status === "enabled";
  const needsSelector =
    request.status === "pending" ||
    (request.status === "completed" &&
      publicationEnabled &&
      !["published", "legacy_unavailable"].includes(publication.state));
  if (request.status !== "pending" && request.status !== "completed") {
    button?.remove();
    return;
  }
  if (request.status === "pending" && publication.config_status === "invalid")
    return;

  let session: NoaSession | null = null;
  let connector: NearConnector | null = null;
  let accounts: { accountId: string }[] = [];
  const activeAccount = () => accounts[0]?.accountId;
  const signMessage = async (params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
  }) => {
    const wallet = (await connector!.wallet()) as any;
    if (typeof wallet.signMessage !== "function")
      throw new Error("signMessage is not supported");
    // callbackUrl intentionally omitted: Noa verifies NEP-413 with callbackUrl = null.
    return wallet.signMessage({
      message: params.message,
      recipient: params.recipient,
      nonce: Buffer.from(params.nonce),
    });
  };
  const deps = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    signMessage,
  };
  const post = async (path: string, body?: unknown) =>
    getJson(`/api/sign/${encodeURIComponent(id)}/publication/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  const verify = async (): Promise<ServerVerify> => {
    const outcome = await post("verify");
    publication = outcome.publication ?? publication;
    return outcome;
  };
  const report = async (state: PublishState, code?: PublicationErrorCode) => {
    try {
      const outcome = await post("report", { state, error_code: code });
      publication = outcome.publication ?? publication;
    } catch {
      /* progress reporting is best effort */
    }
    renderPublication(publication, undefined, publishNow);
  };
  const publishNow = async () => {
    if (!publication.payload || !publication.noa || !publication.creator)
      return;
    if (publicationButton) publicationButton.disabled = true;
    if (session && session.accountId !== activeAccount()) session = null;
    if (!activeAccount() && connector) {
      setStatus("Connect your wallet to publish the description and rules to Noa.", "busy");
      await connectWallet();
    }
    try {
      const result = await recoverPublication(deps, {
        apiUrl: publication.noa.api_url,
        recipient: publication.noa.auth_recipient,
        creator: publication.creator,
        payload: publication.payload,
        verify,
        report,
        session,
      });
      session = result.session;
      try {
        await verify();
      } catch {
        /* keep last known view */
      }
      renderPublication(publication, undefined, publishNow);
    } catch (error) {
      renderPublication(publication, (error as Error).message, publishNow);
    }
  };
  async function connectWallet(): Promise<string> {
    let accountId = activeAccount();
    if (accountId) return accountId;
    setStatus("Choose a wallet in the window that opened.", "busy");
    const wallet = await connector!.connect();
    accounts = await wallet.getAccounts();
    accountId = activeAccount();
    if (!accountId) throw new Error("Wallet returned no account");
    setCreator(accountId);
    return accountId;
  }
  const onCompleted = (data: Record<string, any>) => {
    showResult(data);
    button?.remove();
    document.querySelector(".act")?.remove();
    setPill("created", "Created");
    setStatus("Signed and confirmed on-chain.", "ok");
    // Refresh the server-side publication view (payload needs the trusted market id).
    return getJson(`/api/sign/${encodeURIComponent(id)}`)
      .then((fresh: PublicRequest) => {
        publication = fresh.publication;
        renderPublication(publication, undefined, publishNow);
        if (publication.config_status === "enabled" && publication.payload)
          void publishNow();
      })
      .catch(() => undefined);
  };

  if (needsSelector) {
    connector = new NearConnector({
      network: request.network.networkId,
      manifest: WALLET_MANIFEST as any,
    });
    const onSignOut = () => {
      // Account switch/sign-out: discard the Noa session.
      accounts = [];
      setCreator(request.params.creator ?? undefined);
      session = null;
    };
    connector.on("wallet:signIn", (event: any) => {
      accounts = event.accounts ?? [];
      setCreator(activeAccount() ?? request.params.creator ?? undefined);
      if (session && session.accountId !== activeAccount()) session = null;
    });
    connector.on("wallet:signOut", onSignOut);
    try {
      accounts = await (await connector.wallet()).getAccounts();
    } catch {
      /* not signed in */
    }
  }

  if (request.status === "completed") {
    button?.remove();
    if (request.result) showResult(request.result);
    renderPublication(publication, undefined, publishNow);
    // Server read-back needs no token or wallet; may already be published.
    if (
      publicationEnabled &&
      publication.state !== "published" &&
      publication.payload
    ) {
      try {
        await verify();
      } catch {
        /* rate limited or unreachable: leave retry button */
      }
      renderPublication(publication, undefined, publishNow);
    }
    return;
  }

  const hashes = new URLSearchParams(location.search)
    .get("transactionHashes")
    ?.split(",")
    .filter(Boolean);
  if (hashes?.length) {
    try {
      const accountId =
        sessionStorage.getItem(`noacourt:${id}:account`) || activeAccount();
      if (!accountId) throw new Error("Wallet account missing after redirect");
      const verified = await getJson(
        `/api/sign/${encodeURIComponent(id)}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tx_hashes: hashes, account_id: accountId }),
        },
      );
      history.replaceState(null, "", location.pathname);
      await onCompleted(verified);
      return;
    } catch (error) {
      setStatus(`We could not verify the return from your wallet: ${(error as Error).message}`, "bad");
    }
  }
  button!.onclick = async () => {
    try {
      button!.disabled = true;
      button!.textContent = "Waiting for wallet…";
      const accountId = await connectWallet();
      sessionStorage.setItem(`noacourt:${id}:account`, accountId);
      if (publicationEnabled && publication.noa) {
        // Noa login BEFORE any create transaction: declined/unsupported wallets stop here.
        setStatus("Approve the Noa sign-in message in your wallet. It proves you own the account and costs nothing.", "busy");
        try {
          session = await noaLogin(deps, {
            apiUrl: publication.noa.api_url,
            recipient: publication.noa.auth_recipient,
            expectedAccountId: accountId,
          });
        } catch (error) {
          const code = (error as { code?: string }).code ?? "other";
          throw new Error(
            `Noa login failed (${code}). Metadata publication needs creator authentication; no transaction was requested. Retry, or use Meteor, Intear or HOT Wallet.`,
          );
        }
      }
      setStatus("Preparing your transactions…", "busy");
      const plan = await getJson(
        `/api/sign/${encodeURIComponent(id)}/plan?account=${encodeURIComponent(accountId)}`,
      );
      const wallet = await connector!.wallet();
      setStatus("Approve the transactions in your wallet. Check the amounts there before confirming.", "busy");
      const outcomes = await (wallet as any).signAndSendTransactions({
        transactions: plan.tx_plan,
        network: request.network.networkId,
      });
      if (Array.isArray(outcomes)) {
        const tx_hashes = outcomes
          .map((outcome: any) => outcome.transaction?.hash)
          .filter(Boolean);
        const value = outcomes.at(-1)?.status?.SuccessValue;
        if (value) {
          try {
            setStatus(`Your wallet reported market #${JSON.parse(atob(value)).market_id}. Confirming on-chain…`, "busy");
          } catch {
            /* server verifies result */
          }
        }
        const verified = await getJson(
          `/api/sign/${encodeURIComponent(id)}/complete`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tx_hashes, account_id: accountId }),
          },
        );
        await onCompleted(verified);
      } else
        setStatus("Approve the transactions in your wallet, then return to this page.", "busy");
    } catch (error) {
      setStatus(`Could not finish signing: ${(error as Error).message}. You can try again.`, "bad");
      if ((error as Error & { status?: number }).status === 409)
        button?.remove();
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Connect wallet and sign";
      }
    }
  };
}
void main().catch((error) => {
  details.replaceChildren();
  details.removeAttribute("aria-busy");
  setStatus(`This page could not load: ${error.message}. Reload to try again.`, "bad");
  button?.remove();
});
