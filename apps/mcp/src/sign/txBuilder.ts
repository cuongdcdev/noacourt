import { DEFAULT_RETRY_POLICY } from "../spec/defaults.js";

export type WalletTransaction = {
  signerId?: string;
  receiverId: string;
  actions: {
    type: "FunctionCall";
    params: {
      methodName: string;
      args: Record<string, unknown>;
      gas: string;
      deposit: string;
    };
  }[];
};

export type BuildInput = {
  spec_json: string;
  spec_hash: string;
  title: string;
  outcomes: string[];
  stake?: string;
  stake_yocto?: string;
  token_id?: string;
  token_decimals?: number;
  duration_minutes?: number;
  duration_days?: number;
  resolution_window_minutes?: number;
  court_max_attempts?: number;
  observation_at?: string;
  expiration_estimate_at?: string;
  requested_close_at?: string;
  court_contract: string;
  noa_contract: string;
  register_deposit_yocto?: string;
  create_market_deposit_yocto?: string;
  internal_balance_yocto?: string;
  signer_id?: string;
  creator?: string;
};

export function effectiveAttempts(
  specAttempts?: number | null,
  courtAttempts?: number | null,
): number {
  for (const value of [specAttempts, courtAttempts]) {
    if (value != null && (!Number.isSafeInteger(value) || value < 1))
      throw new Error("retry max_attempts must be a positive integer");
  }
  if (specAttempts != null && courtAttempts != null)
    return Math.min(specAttempts, courtAttempts);
  return specAttempts ?? courtAttempts ?? DEFAULT_RETRY_POLICY.max_attempts;
}

export function requiredResolutionWindowMinutes(
  observationAt: string,
  expirationEstimateAt: string,
  attempts: number,
  every: string,
): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("retry max_attempts must be a positive integer");
  const match = typeof every === "string" && /^(\d+)(s|m|h|d)$/.exec(every);
  if (!match)
    throw new Error("retry.every must be a duration using s, m, h, or d");
  const multiplier = { s: 1n, m: 60n, h: 3600n, d: 86400n }[
    match[2] as "s" | "m" | "h" | "d"
  ];
  const retrySeconds = BigInt(match[1]) * multiplier;
  const observation = Date.parse(observationAt);
  const expiration = Date.parse(expirationEstimateAt);
  if (!Number.isFinite(observation) || !Number.isFinite(expiration))
    throw new Error("observation and expiration estimates must be UTC times");
  if (expiration > observation)
    throw new Error("market expiration estimate must be <= observation.at");
  const requiredMs =
    BigInt(observation - expiration) +
    BigInt(attempts) * retrySeconds * 1000n +
    7n * 60_000n;
  const minutes = (requiredMs + 59_999n) / 60_000n;
  if (minutes > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("required resolution window is too large");
  return Math.max(10, Number(minutes));
}

export function decimalToUnits(amount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error("invalid token decimals");
  if (!/^\d+(?:\.\d+)?$/.test(amount))
    throw new Error("stake must be a nonnegative decimal string");
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals)
    throw new Error(`stake has more than ${decimals} decimals`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  ).toString();
}

function nonnegative(value: string, name: string): bigint {
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a nonnegative integer string`);
  return BigInt(value);
}

function call(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  gas: string,
  deposit: string,
  signerId?: string,
): WalletTransaction {
  return {
    ...(signerId ? { signerId } : {}),
    receiverId,
    actions: [
      { type: "FunctionCall", params: { methodName, args, gas, deposit } },
    ],
  };
}

export function buildCreateMarketTxs(input: BuildInput): WalletTransaction[] {
  if (!/^sha256:[a-f0-9]{64}$/i.test(input.spec_hash))
    throw new Error("invalid spec_hash");
  if (
    (input.duration_minutes === undefined) ===
    (input.duration_days === undefined)
  )
    throw new Error("provide exactly one duration");
  const spec = JSON.parse(input.spec_json) as Record<string, any>;
  const observationAt = input.observation_at ?? spec.observation?.at;
  if (typeof observationAt !== "string")
    throw new Error("spec.observation.at is required for the transaction plan");
  const durationMinutes =
    input.duration_minutes ?? (input.duration_days ?? 0) * 1440;
  if (
    !Number.isSafeInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 365 * 1440
  )
    throw new Error("market duration must be 5 minutes to 365 days");
  const expirationEstimateAt =
    input.expiration_estimate_at ??
    new Date(Date.now() + durationMinutes * 60_000).toISOString();
  const requiredWindow = requiredResolutionWindowMinutes(
    observationAt,
    expirationEstimateAt,
    effectiveAttempts(spec.retry?.max_attempts, input.court_max_attempts),
    spec.retry?.every ?? DEFAULT_RETRY_POLICY.every,
  );
  const resolutionWindow = input.resolution_window_minutes ?? requiredWindow;
  if (
    !Number.isSafeInteger(resolutionWindow) ||
    resolutionWindow < requiredWindow
  )
    throw new Error(
      `resolution_window_minutes must be at least ${requiredWindow} for spec retries and Noa minimum`,
    );
  if (resolutionWindow > 365 * 1440)
    throw new Error("resolution_window_minutes exceeds Noa's 365-day maximum");
  // The server always supplies token_id (config.marketToken is network-aware); this default is only for direct library use/tests.
  const tokenId = input.token_id || "point.noamarket.testnet";
  const stake = nonnegative(
    input.stake_yocto ??
      decimalToUnits(input.stake || "", input.token_decimals ?? 18),
    "stake",
  );
  if (stake === 0n) throw new Error("stake must be positive");
  const balance = nonnegative(
    input.internal_balance_yocto ?? stake.toString(),
    "internal_balance_yocto",
  );
  // Noa charges the 0.5 NEAR creation fee plus measured storage and does not refund excess.
  // 0.1 NEAR is an explicit storage buffer until the signer plan reads live config.
  const registerDeposit = nonnegative(
    input.register_deposit_yocto ?? "100000000000000000000000",
    "register_deposit_yocto",
  ).toString();
  const createDeposit = nonnegative(
    input.create_market_deposit_yocto ?? "600000000000000000000000",
    "create_market_deposit_yocto",
  ).toString();
  const transactions: WalletTransaction[] = [];
  if (balance < stake)
    transactions.push(
      call(
        tokenId,
        "ft_transfer_call",
        {
          receiver_id: input.noa_contract,
          amount: (stake - balance).toString(),
          msg: "",
        },
        "100000000000000",
        "1",
        input.signer_id,
      ),
    );
  transactions.push(
    call(
      input.court_contract,
      "register_spec",
      { spec_json: input.spec_json },
      "100000000000000",
      registerDeposit,
      input.signer_id,
    ),
  );
  transactions.push(
    call(
      input.noa_contract,
      "create_market",
      {
        title: input.title,
        metadata_hash: `noacourt:${input.spec_hash}`,
        token_id: tokenId,
        stake_amount: stake.toString(),
        outcomes: input.outcomes,
        resolver: input.court_contract,
        duration_minutes: input.duration_minutes ?? null,
        duration_days: input.duration_days ?? null,
        resolution_window_minutes: resolutionWindow,
      },
      "100000000000000",
      createDeposit,
      input.signer_id,
    ),
  );
  return transactions;
}

export function parseCreateMarketResult(txOutcome: unknown): {
  market_id: number;
} {
  const object = txOutcome as Record<string, any> | undefined;
  const encoded =
    object?.status?.SuccessValue ?? object?.outcome?.status?.SuccessValue;
  if (typeof encoded !== "string" || !encoded)
    throw new Error("create_market transaction has no SuccessValue");
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("create_market SuccessValue is not JSON");
  }
  const raw = result.market_id;
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : NaN;
  if (!Number.isSafeInteger(id) || id < 0)
    throw new Error("create_market result has invalid market_id");
  return { market_id: id };
}
