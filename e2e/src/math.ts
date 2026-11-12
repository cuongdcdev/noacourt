export function decimalUnits(value: string, decimals = 18): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error(`Invalid decimal: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new Error(`Too many decimal places: ${value}`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function yocto(value: string): string {
  return decimalUnits(value, 24).toString();
}

export function unitsDecimal(units: bigint, decimals = 18): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function bucketEdges(price: string): [string, string] {
  const units = decimalUnits(price, 10);
  return [
    unitsDecimal((units * 999n) / 1000n, 10),
    unitsDecimal((units * 1001n) / 1000n, 10),
  ];
}

export function compareDecimals(left: string, right: string): number {
  const a = decimalUnits(left, 18);
  const b = decimalUnits(right, 18);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function thresholdOutcome(actual: string, value: string): string {
  return compareDecimals(actual, value) >= 0 ? "Yes" : "No";
}

export function bucketOutcome(actual: string, edges: [string, string]): string {
  if (compareDecimals(actual, edges[0]) < 0) return "Below";
  if (compareDecimals(actual, edges[1]) < 0) return "Flat";
  return "Above";
}

export function changeOutcome(current: string, baseline: string): string {
  const comparison = compareDecimals(current, baseline);
  return comparison > 0 ? "Up" : comparison < 0 ? "Down" : "Tie";
}
