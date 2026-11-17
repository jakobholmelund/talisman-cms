/** Percentage adjustments are rounded once in minor units; previews become absolute assignments. */
export function cataloguePrice(
  base: number,
  mode: "set" | "increase" | "decrease",
  input: string,
): number | null {
  if (mode === "set") {
    const n = Number(input);
    return /^\d+$/.test(input) && Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) return null;
  const basis = Math.round(Number(input) * 100);
  if (
    !Number.isSafeInteger(basis) ||
    basis <= 0 ||
    basis > 100000 ||
    (mode === "decrease" && basis >= 10000) ||
    !Number.isSafeInteger(base) ||
    base < 0
  )
    return null;
  const factor = BigInt(mode === "increase" ? 10000 + basis : 10000 - basis);
  const result = (BigInt(base) * factor + 5000n) / 10000n;
  return result > 0n && result <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(result)
    : null;
}
export function catalogueRange(
  row: {
    minCustom: number | null;
    maxCustom: number | null;
    inheritedPrices: number;
  },
  base: number,
) {
  const values = [
    ...(row.minCustom === null ? [] : [row.minCustom, row.maxCustom!]),
    ...(row.inheritedPrices ? [base] : []),
  ];
  return { min: Math.min(...values), max: Math.max(...values) };
}
