/**
 * Two-phase reversal strategy — pure helpers.
 *
 * Phase 1: enter Q. Target +0.8% (qty Q). SL −0.8% (qty round(3.5·Q) — this
 *          leg flips you to a net 2.5·Q position the other way).
 * Phase 2: on the reversed position, Target/SL ±0.8% (qty = the reversed size).
 *          Whichever fills, the cycle ends. No Phase 3.
 */

export const SL_PCT = 0.8;
export const REVERSE_MULT = 3.5; // SL leg = round(REVERSE_MULT · Q); leftover after close = 2.5·Q
/** Nudge each leg's limit toward the side that guarantees a fill. */
const FILL_BUFFER = 0.0015;

const r2 = (n) => Math.round(n * 100) / 100;

/** exitAction is the side that CLOSES the position: SELL for a long, BUY for a short. */
export function exitActionFor(positionSide) {
  return positionSide === "BUY" ? "SELL" : "BUY";
}

/**
 * SL + target legs for a position of `side` opened at `entryPrice`.
 * `slQty` / `targetQty` are supplied by the caller (they differ per phase).
 */
export function ocoLegs({ side, entryPrice, slQty, targetQty, pct = SL_PCT }) {
  const off = pct / 100;
  const exit_action = exitActionFor(side);
  if (side === "BUY") {
    // long: target above, SL below; exit orders SELL → limit a touch under trigger
    const targetTrig = entryPrice * (1 + off);
    const slTrig = entryPrice * (1 - off);
    return {
      exit_action,
      target_trigger: r2(targetTrig),
      target_limit: r2(targetTrig * (1 - FILL_BUFFER)),
      target_quantity: targetQty,
      sl_trigger: r2(slTrig),
      sl_limit: r2(slTrig * (1 - FILL_BUFFER)),
      sl_quantity: slQty,
    };
  }
  // short: target below, SL above; exit orders BUY → limit a touch over trigger
  const targetTrig = entryPrice * (1 - off);
  const slTrig = entryPrice * (1 + off);
  return {
    exit_action,
    target_trigger: r2(targetTrig),
    target_limit: r2(targetTrig * (1 + FILL_BUFFER)),
    target_quantity: targetQty,
    sl_trigger: r2(slTrig),
    sl_limit: r2(slTrig * (1 + FILL_BUFFER)),
    sl_quantity: slQty,
  };
}

export function phase1SlQty(q) {
  return Math.round(REVERSE_MULT * q);
}

/** Net position left after the Phase-1 SL leg fills (it sold/bought 3.5·Q, held Q). */
export function reversedQty(q) {
  return phase1SlQty(q) - q;
}

/** Does a completed order look like this GTT leg firing? symbol + side + ~quantity. */
export function orderMatchesLeg(order, { tradingsymbol, action, quantity, since }) {
  if (!order || order.status !== "COMPLETE") return false;
  if (order.tradingsymbol !== tradingsymbol) return false;
  if (order.action !== action) return false;
  if (quantity != null && order.filled_quantity !== quantity) return false;
  if (since && new Date(order.placed_at) < new Date(since)) return false;
  return true;
}
