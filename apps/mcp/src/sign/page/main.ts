import "@near-wallet-selector/modal-ui/styles.css";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMeteorWalletApp } from "@near-wallet-selector/meteor-wallet-app";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
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
  };
  sign_before?: string;
  rules_markdown: string;
  description?: string | null;
  metadata_digest?: string | null;
  spec_hash?: string;
  publication: PublicationView;
  qr_url: string;
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

function line(label: string, value: string) {
  const p = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  p.append(strong, document.createTextNode(value));
  details.append(p);
}
function showResult(data: Record<string, any>) {
  result.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = `Market #${data.market_id}`;
  result.append(heading);
  const status = document.createElement("p");
  status.textContent = data.linked
    ? "Linked to Noa Court"
    : `Created; keeper will retry linking${data.link_error ? ` (${data.link_error})` : ""}`;
  result.append(status);
  for (const hash of [
    ...(data.tx_hashes || []),
    ...(data.link_tx_hash ? [data.link_tx_hash] : []),
  ]) {
    const p = document.createElement("p");
    const a = document.createElement("a");
    a.href = `https://testnet.nearblocks.io/txns/${encodeURIComponent(hash)}`;
    a.textContent = `Transaction ${hash}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    p.append(a);
    result.append(p);
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
  not_started: "Metadata not published yet",
  auth_required: "Noa login needed to publish metadata",
  publishing: "Publishing metadata to Noa…",
  awaiting_verification: "Published; waiting for Noa read-back to confirm",
  published: "Metadata published and verified on Noa",
  retryable_error: "Metadata publication failed; you can retry",
  conflict:
    "Noa holds different metadata for this market; stopped (write-once)",
  legacy_unavailable:
    "Legacy request without a reviewed metadata snapshot; not published automatically",
  disabled: "Metadata publication is not configured on this deployment",
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
  const heading = document.createElement("h3");
  heading.textContent = "Noa metadata";
  const text = document.createElement("p");
  text.textContent = `${STATE_TEXT[view.state] ?? view.state}${view.error ? ` (${view.error})` : ""}${extra ? ` ${extra}` : ""}`;
  if (["conflict", "retryable_error"].includes(view.state))
    text.className = "error";
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
    p.textContent = `Last verified ${view.last_verified_at}`;
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
        ? "Publish metadata to Noa"
        : "Retry metadata publication";
    publicationButton.onclick = onRetry;
    publicationBox.append(publicationButton);
  }
}

function banners(view: PublicationView) {
  banner.replaceChildren();
  const add = (message: string, bad = false) => {
    const div = document.createElement("div");
    div.className = bad ? "banner bad" : "banner";
    div.textContent = message;
    banner.append(div);
  };
  if (view.config_status === "disabled")
    add(
      "Metadata publication not configured on this deployment: the market will be created without a Noa description or rules.",
    );
  if (view.config_status === "invalid")
    add(
      `Metadata publication configuration is invalid; new markets cannot be created from this deployment: ${view.config_error}`,
      true,
    );
}

async function main() {
  let request: PublicRequest;
  try {
    request = await getJson(`/api/sign/${encodeURIComponent(id)}`);
  } catch (error) {
    state.textContent = (error as Error).message.includes("expired")
      ? "expired"
      : "not found";
    button?.remove();
    return;
  }
  state.textContent = request.status;
  let publication = request.publication;
  banners(publication);
  if (publication.config_status === "invalid") button?.remove();
  line("Outcomes", request.params.outcomes.join(" · "));
  line(
    "Stake",
    `${request.params.stake} ${request.params.token_id || "NPOINT"}`,
  );
  if (request.sign_before)
    line(
      "Sign before",
      new Date(request.sign_before)
        .toISOString()
        .replace("T", " ")
        .slice(0, 16) + " UTC",
    );
  if (request.spec_hash) line("Spec hash", request.spec_hash);
  if (request.metadata_digest) line("Metadata digest", request.metadata_digest);
  document.getElementById("description")!.textContent =
    request.description ?? "(no reviewed description: legacy request)";
  document.getElementById("rules")!.textContent = request.rules_markdown;
  const qr = document.getElementById("qr") as HTMLImageElement;
  const qrData = await getJson(`/api/sign/${encodeURIComponent(id)}/qr`);
  qr.src = qrData.qr_png_data_url;
  qr.hidden = false;

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
  let selector: Awaited<ReturnType<typeof setupWalletSelector>> | null = null;
  const activeAccount = () => {
    const accounts = selector?.store.getState().accounts ?? [];
    return (accounts.find((a: any) => a.active) ?? accounts[0])?.accountId;
  };
  const signMessage = async (params: {
    message: string;
    recipient: string;
    nonce: Uint8Array;
  }) => {
    const wallet = (await selector!.wallet()) as any;
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
    if (!activeAccount() && selector) {
      state.textContent = "Connect the creator wallet to publish metadata";
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
    state.textContent = "Choose a wallet to continue";
    const signedIn = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        subscription.unsubscribe();
        reject(new Error("Wallet sign-in timed out"));
      }, 120_000);
      const subscription = selector!.on(
        "signedIn",
        (event: { accounts: { accountId: string }[] }) => {
          clearTimeout(timeout);
          subscription.unsubscribe();
          const account = event.accounts[0]?.accountId;
          account
            ? resolve(account)
            : reject(new Error("Wallet returned no account"));
        },
      );
    });
    modal.show();
    accountId = await signedIn;
    return accountId;
  }
  const onCompleted = (data: Record<string, any>) => {
    showResult(data);
    button?.remove();
    state.textContent = "completed";
    state.className = "";
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
    // MyNearWallet cannot be relied on for NEP-413 login; keep it only when publication is off.
    const modules: any[] = [
      setupIntearWallet(),
      setupMeteorWallet(),
      setupMeteorWalletApp({
        contractId: request.network.courtContract,
      } as any),
      setupHotWallet(),
    ];
    if (!publicationEnabled) modules.push(setupMyNearWallet());
    selector = await setupWalletSelector({
      network: request.network,
      modules,
    } as any);
    selector.store.observable.subscribe(() => {
      // Account switch: discard the Noa session.
      if (session && session.accountId !== activeAccount()) session = null;
    });
  }
  const modal = needsSelector
    ? setupModal(selector!, { contractId: request.network.courtContract })
    : (null as never);

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
      state.textContent = `Could not verify wallet return: ${(error as Error).message}`;
    }
  }
  button!.onclick = async () => {
    try {
      button!.disabled = true;
      const accountId = await connectWallet();
      sessionStorage.setItem(`noacourt:${id}:account`, accountId);
      if (publicationEnabled && publication.noa) {
        // Noa login BEFORE any create transaction: declined/unsupported wallets stop here.
        state.textContent = "Sign the Noa login message in your wallet…";
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
      state.textContent = "Preparing transactions…";
      const plan = await getJson(
        `/api/sign/${encodeURIComponent(id)}/plan?account=${encodeURIComponent(accountId)}`,
      );
      const wallet = await selector!.wallet();
      const outcomes = await (wallet as any).signAndSendTransactions({
        transactions: plan.tx_plan,
        callbackUrl: location.href,
      });
      if (Array.isArray(outcomes)) {
        const tx_hashes = outcomes
          .map((outcome: any) => outcome.transaction?.hash)
          .filter(Boolean);
        const value = outcomes.at(-1)?.status?.SuccessValue;
        if (value) {
          try {
            state.textContent = `Wallet reported market #${JSON.parse(atob(value)).market_id}; verifying…`;
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
        state.textContent =
          "Approve transactions in your wallet, then return here";
    } catch (error) {
      state.textContent = (error as Error).message;
      state.className = "error";
      if ((error as Error & { status?: number }).status === 409)
        button?.remove();
    } finally {
      if (button) button.disabled = false;
    }
  };
}
void main().catch((error) => {
  state.textContent = `Sign page unavailable: ${error.message}`;
  button?.remove();
});
