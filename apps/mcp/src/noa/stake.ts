// Bit-exact BigInt port of Noa's minimum-liquidity guard, mirrored from the Noa frontend
// (apps/frontend/src/lib/near/lmsr.ts `calculateBFromStake`/`fpLn` and
// components/features/create/stake-liquidity.ts), which in turn mirrors the contract's
// contracts/src/math.rs. The contract asserts `b > 0 && b >= token.min_b_shares_fp` in create_market.
// No floats: do not "improve" the precision, any drift makes us accept/reject differently from chain.

const SCALE = 10n ** 18n;
const LN_2_FP = 693_147_180_559_945_309n;
const SQRT2_FP = 1_414_213_562_373_095_049n;

export function fpLn(x: bigint): bigint {
  if (x <= 0n) throw new Error("ln(0) is undefined");
  if (x === SCALE) return 0n;
  let k = 0n;
  let m = x;
  while (m >= 2n * SCALE) {
    m /= 2n;
    k += 1n;
  }
  while (m < SCALE) {
    m *= 2n;
    k -= 1n;
  }
  if (m > SQRT2_FP) {
    m = m / 2n;
    k += 1n;
  }
  const y = m - SCALE;
  let result = 0n;
  let term = y;
  for (let i = 1n; i <= 30n; i++) {
    const contribution = term / i;
    result += i % 2n === 1n ? contribution : -contribution;
    term = (term * y) / SCALE;
    if (contribution < 1n && contribution > -1n) break;
  }
  return result + k * LN_2_FP;
}

/** Contract `calculate_b_from_stake`: b = stake * safety / ln(N), integer-identical. */
export function calculateBFromStake(
  stakeAmount: bigint,
  tokenDecimals: number,
  outcomeCount: number,
  safetyBps: number,
): bigint {
  if (outcomeCount < 2) return 0n;
  const tokenScale = 10n ** BigInt(tokenDecimals);
  const stakeFp = (stakeAmount * SCALE) / tokenScale;
  const lnN = fpLn(BigInt(outcomeCount) * SCALE);
  if (lnN <= 0n) return 0n;
  const safetyFactor = (BigInt(safetyBps) * SCALE) / 10_000n;
  const stakeWithSafety = (stakeFp * safetyFactor) / SCALE;
  return (stakeWithSafety * SCALE) / lnN;
}

export type StakeLiquidityInput = {
  stakeAtomic: bigint;
  decimals: number;
  outcomeCount: number;
  safetyBps: number;
  minBSharesFp: bigint;
};

export function stakeMeetsMinimumLiquidity(i: StakeLiquidityInput): boolean {
  if (i.stakeAtomic <= 0n || i.outcomeCount < 2) return false;
  const b = calculateBFromStake(
    i.stakeAtomic,
    i.decimals,
    i.outcomeCount,
    i.safetyBps,
  );
  return b > 0n && b >= i.minBSharesFp;
}

/** Smallest atomic stake clearing the guard (doubling probe + binary search), or null. */
export function minimumStakeAtomic(
  input: Omit<StakeLiquidityInput, "stakeAtomic">,
): bigint | null {
  const ok = (stakeAtomic: bigint) =>
    stakeMeetsMinimumLiquidity({ ...input, stakeAtomic });
  if (input.outcomeCount < 2) return null;
  let hi = 1n;
  for (let i = 0; i < 256 && !ok(hi); i++) hi *= 2n;
  if (!ok(hi)) return null;
  let lo = 0n;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function atomicToHuman(atomic: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = atomic / scale;
  const frac = atomic % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/** Atomic to human, rounded UP (2 decimals >= 1, else 2 significant decimals). Display only. */
export function ceilAtomicToHuman(atomic: bigint, decimals: number): string {
  if (atomic <= 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  let dp = 2;
  if (atomic < scale) {
    const frac = atomic.toString().padStart(decimals, "0");
    const leadingZeros = frac.length - frac.replace(/^0+/, "").length;
    dp = leadingZeros + 2;
  }
  dp = Math.min(dp, decimals);
  const unit = 10n ** BigInt(decimals - dp);
  const steps = (atomic + unit - 1n) / unit;
  return atomicToHuman(steps * unit, decimals);
}
