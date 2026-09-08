// Nifty 500 symbols, bundled so instrument search works with no broker token.
// Source: nifty_500_list.csv (Yahoo tickers) with the ".NS" suffix stripped.
import raw from "../data/nifty500.txt?raw";

const SYMBOLS = raw
  .split(/\r?\n/)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/**
 * Local prefix/substring search. Exact match first, then symbols that start
 * with the query, then symbols that contain it — capped at `limit`.
 */
export function searchSymbols(query, limit = 8) {
  const q = query.trim().toUpperCase();
  if (!q) return [];

  const exact = [];
  const starts = [];
  const contains = [];

  for (const sym of SYMBOLS) {
    if (sym === q) exact.push(sym);
    else if (sym.startsWith(q)) starts.push(sym);
    else if (sym.includes(q)) contains.push(sym);
    if (starts.length + contains.length > limit * 3) break;
  }

  return [...exact, ...starts, ...contains]
    .slice(0, limit)
    .map((tradingsymbol) => ({ tradingsymbol, exchange: "NSE" }));
}
