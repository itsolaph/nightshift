// Money is kept in integer minor units (cents) inside Nightshift and converted to PayPal's
// decimal strings only at the API boundary. Two-decimal currencies only (USD, EUR, GBP...).

export type Money = { cents: number; currency: string };

export function toCents(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const text = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new Error(`Not a money amount: ${value}`);
  const negative = text.startsWith("-");
  const [whole, frac = ""] = text.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function toDecimal(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${toDecimal(cents)} ${currency}`;
  }
}

export const paypalAmount = (cents: number, currency: string) => ({
  currency_code: currency,
  value: toDecimal(cents),
});
