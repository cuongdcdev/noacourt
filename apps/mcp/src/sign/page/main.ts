import "@near-wallet-selector/modal-ui/styles.css";
import { setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";

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
  qr_url: string;
  result?: Record<string, any>;
  network: {
    networkId: "testnet" | "mainnet";
    nodeUrl: string;
    courtContract: string;
  };
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
  document.getElementById("rules")!.textContent = request.rules_markdown;
  const qr = document.getElementById("qr") as HTMLImageElement;
  const qrData = await getJson(`/api/sign/${encodeURIComponent(id)}/qr`);
  qr.src = qrData.qr_png_data_url;
  qr.hidden = false;
  if (request.status === "completed" && request.result) {
    button?.remove();
    showResult(request.result);
    return;
  }
  if (request.status !== "pending") {
    button?.remove();
    return;
  }
  const selector = await setupWalletSelector({
    network: request.network,
    modules: [setupIntearWallet(), setupMeteorWallet(), setupMyNearWallet()],
  } as any);
  const modal = setupModal(selector, {
    contractId: request.network.courtContract,
  });
  const hashes = new URLSearchParams(location.search)
    .get("transactionHashes")
    ?.split(",")
    .filter(Boolean);
  if (hashes?.length) {
    try {
      const accountId =
        sessionStorage.getItem(`noacourt:${id}:account`) ||
        selector.store.getState().accounts[0]?.accountId;
      if (!accountId) throw new Error("Wallet account missing after redirect");
      const verified = await getJson(
        `/api/sign/${encodeURIComponent(id)}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tx_hashes: hashes, account_id: accountId }),
        },
      );
      showResult(verified);
      button?.remove();
      history.replaceState(null, "", location.pathname);
      return;
    } catch (error) {
      state.textContent = `Could not verify wallet return: ${(error as Error).message}`;
    }
  }
  button!.onclick = async () => {
    try {
      button!.disabled = true;
      let accountId = selector.store.getState().accounts[0]?.accountId;
      if (!accountId) {
        state.textContent = "Choose a wallet to continue";
        const signedIn = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            subscription.unsubscribe();
            reject(new Error("Wallet sign-in timed out"));
          }, 120_000);
          const subscription = selector.on(
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
      }
      sessionStorage.setItem(`noacourt:${id}:account`, accountId);
      const plan = await getJson(
        `/api/sign/${encodeURIComponent(id)}/plan?account=${encodeURIComponent(accountId)}`,
      );
      const wallet = await selector.wallet();
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
        showResult(verified);
        button?.remove();
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
