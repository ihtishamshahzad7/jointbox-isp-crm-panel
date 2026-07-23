"use client";

/**
 * One place that decides how money is rendered across the whole panel.
 *
 * This product is deployed by operators in different countries — Pakistan,
 * India, Bangladesh, the Gulf — so a hard-coded "$" (or even "PKR") is wrong
 * for most of them. Every amount in the UI should go through `money()`.
 *
 * The symbol is read from the ISP record and cached locally so it survives a
 * page reload without an extra request on every render.
 */

const KEY = "jb_currency";

export type Currency = { code: string; symbol: string };

const DEFAULT: Currency = { code: "PKR", symbol: "Rs" };

/** Common presets so operators don't have to type the symbol by hand. */
export const CURRENCIES: Currency[] = [
  { code: "PKR", symbol: "Rs" },
  { code: "INR", symbol: "₹" },
  { code: "BDT", symbol: "৳" },
  { code: "LKR", symbol: "Rs" },
  { code: "NPR", symbol: "Rs" },
  { code: "AFN", symbol: "؋" },
  { code: "AED", symbol: "AED" },
  { code: "SAR", symbol: "SAR" },
  { code: "USD", symbol: "$" },
  { code: "EUR", symbol: "€" },
  { code: "GBP", symbol: "£" },
];

export function getCurrency(): Currency {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Currency;
  } catch {
    /* fall through to default */
  }
  return DEFAULT;
}

export function setCurrency(c: Currency) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, JSON.stringify(c));
  // Let any open screen re-render with the new symbol.
  window.dispatchEvent(new Event("jb-currency-changed"));
}

/**
 * Format an amount for display: `money(1500)` -> "Rs 1,500".
 *
 * Grouping follows the browser locale, so Indian deployments get the lakh/crore
 * grouping (1,50,000) they expect rather than 150,000.
 */
export function money(n: number | string | null | undefined, opts?: { decimals?: number }): string {
  const value = Number(n ?? 0);
  const safe = Number.isFinite(value) ? value : 0;
  const decimals = opts?.decimals ?? (Number.isInteger(safe) ? 0 : 2);
  const { symbol } = getCurrency();
  return `${symbol} ${safe.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Just the symbol — for input adornments and column headers. */
export function currencySymbol(): string {
  return getCurrency().symbol;
}

/** Pull the operator's configured currency from the API and cache it. */
export async function loadCurrencyFromApi(apiBase: string, token: string | null) {
  if (!token) return;
  try {
    const r = await fetch(`${apiBase}/organization/isps`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return;
    const isps = await r.json();
    const isp = Array.isArray(isps) ? isps[0] : null;
    if (isp?.currency) {
      setCurrency({ code: isp.currency, symbol: isp.currencySymbol || isp.currency });
    }
  } catch {
    /* keep whatever is cached */
  }
}
