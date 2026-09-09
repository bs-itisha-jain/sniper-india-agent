import { Router } from "express";
import { withKite, hasAccessToken, classifyKiteError } from "../services/kiteClient.js";
import { logger } from "../logger.js";

const router = Router();

const PRODUCTS = new Set(["CNC", "MIS", "NRML"]);

const HTTP_FOR_CODE = {
  token_expired: 401,
  connection: 504,
  invalid_input: 400,
  forbidden: 403,
  api_error: 502,
};

function fail(res, err, fallback) {
  const code = classifyKiteError(err);
  return res.status(HTTP_FOR_CODE[code] || 502).json({
    error: err.message || fallback,
    code,
  });
}

const noToken = (res) =>
  res.status(503).json({ error: "Zerodha access token not available yet", code: "no_token" });

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Validate the full ticket: an entry (trigger + limit) plus a protective
 * SL / target pair.
 *
 * `action` is the position being taken:
 *   BUY  → go long  → entry is a BUY;  exit legs SELL; SL below entry, target above
 *   SELL → go short → entry is a SELL; exit legs BUY;  SL above entry, target below
 *
 * Zerodha GTT rule: for a BUY leg trigger ≤ price, for a SELL leg trigger ≥ price.
 */
function parseTicket(body) {
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const action = String(body.action || "").trim().toUpperCase();
  const product = String(body.product || "CNC").trim().toUpperCase();
  const quantity = Number(body.quantity);
  const triggerPrice = Number(body.trigger_price);
  const limitPrice = Number(body.limit_price);
  const slPrice = Number(body.sl_price);
  const targetPrice = Number(body.target_price);

  if (!symbol) return { error: "symbol is required" };
  if (!["BUY", "SELL"].includes(action)) return { error: "action must be BUY or SELL" };
  if (!Number.isInteger(quantity) || quantity <= 0)
    return { error: "quantity must be a positive integer" };
  if (!(triggerPrice > 0)) return { error: "trigger_price must be a positive number" };
  if (!(limitPrice > 0)) return { error: "limit_price must be a positive number" };
  if (!(slPrice > 0)) return { error: "sl_price must be a positive number" };
  if (!(targetPrice > 0)) return { error: "target_price must be a positive number" };
  if (!PRODUCTS.has(product)) return { error: "product must be CNC, MIS or NRML" };

  if (action === "BUY") {
    if (triggerPrice > limitPrice)
      return { error: "for a BUY the trigger price cannot be higher than the limit price" };
    if (!(slPrice < limitPrice))
      return { error: "for a BUY the stop-loss must be below the limit price" };
    if (!(targetPrice > limitPrice))
      return { error: "for a BUY the target must be above the limit price" };
  } else {
    if (triggerPrice < limitPrice)
      return { error: "for a SELL the trigger price cannot be lower than the limit price" };
    if (!(slPrice > limitPrice))
      return { error: "for a SELL the stop-loss must be above the limit price" };
    if (!(targetPrice < limitPrice))
      return { error: "for a SELL the target must be below the limit price" };
  }

  const [exchange, tradingsymbol] = symbol.includes(":")
    ? symbol.split(":")
    : ["NSE", symbol];

  const exitType = action === "BUY" ? "SELL" : "BUY";

  return {
    exchange,
    tradingsymbol,
    action,
    product,
    quantity,
    triggerPrice: round2(triggerPrice),
    limitPrice: round2(limitPrice),
    slPrice: round2(slPrice),
    targetPrice: round2(targetPrice),
    exitType,
    lower: round2(Math.min(slPrice, targetPrice)),
    upper: round2(Math.max(slPrice, targetPrice)),
  };
}

/** Single-leg entry GTT params. */
function entryParams(kc, p, lastPrice) {
  return {
    trigger_type: kc.GTT_TYPE_SINGLE,
    tradingsymbol: p.tradingsymbol,
    exchange: p.exchange,
    trigger_values: [p.triggerPrice],
    last_price: lastPrice,
    orders: [
      {
        transaction_type:
          p.action === "BUY" ? kc.TRANSACTION_TYPE_BUY : kc.TRANSACTION_TYPE_SELL,
        quantity: p.quantity,
        order_type: kc.ORDER_TYPE_LIMIT,
        product: p.product,
        price: p.limitPrice,
      },
    ],
  };
}

/** Two-leg OCO exit GTT params (SL + target). */
function exitParams(kc, p, lastPrice) {
  const leg = (price) => ({
    transaction_type:
      p.exitType === "BUY" ? kc.TRANSACTION_TYPE_BUY : kc.TRANSACTION_TYPE_SELL,
    quantity: p.quantity,
    order_type: kc.ORDER_TYPE_LIMIT,
    product: p.product,
    price,
  });
  return {
    trigger_type: kc.GTT_TYPE_OCO,
    tradingsymbol: p.tradingsymbol,
    exchange: p.exchange,
    trigger_values: [p.lower, p.upper],
    last_price: lastPrice,
    orders: [leg(p.lower), leg(p.upper)],
  };
}

/** Flatten Kite's GTT object into what the UI needs. */
function shapeTrigger(t) {
  const legs = Array.isArray(t.orders) ? t.orders : [];
  const triggers = t.condition?.trigger_values || [];
  const base = {
    id: t.id,
    status: t.status, // active | triggered | disabled | expired | cancelled | rejected | deleted
    type: t.type, // single | two-leg
    tradingsymbol: t.condition?.tradingsymbol,
    exchange: t.condition?.exchange,
    reference_price: t.condition?.last_price ?? null,
    product: legs[0]?.product || null,
    quantity: legs[0]?.quantity ?? null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    expires_at: t.expires_at || null,
  };

  if (t.type === "two-leg" && legs.length === 2 && triggers.length === 2) {
    const exit = legs[0]?.transaction_type || null; // SELL exits a long, BUY exits a short
    const [lo, hi] = triggers;
    const [loLeg, hiLeg] = legs;
    const isLong = exit === "SELL"; // exit SELL → protecting a long
    return {
      ...base,
      kind: "exit",
      action: isLong ? "BUY" : "SELL", // the position being protected
      sl_price: isLong ? lo : hi,
      target_price: isLong ? hi : lo,
      limit_price: round2((lo + hi) / 2),
      sl_limit: isLong ? loLeg?.price ?? null : hiLeg?.price ?? null,
      target_limit: isLong ? hiLeg?.price ?? null : loLeg?.price ?? null,
    };
  }

  return {
    ...base,
    kind: "entry",
    action: legs[0]?.transaction_type || null,
    trigger_price: triggers[0] ?? null,
    limit_price: legs[0]?.price ?? null,
  };
}

async function fetchLtp(instrument) {
  const ltpResponse = await withKite((kc) => kc.getLTP([instrument]));
  return Number(ltpResponse?.[instrument]?.last_price);
}

/** Flatten a Kite order-book row. Kite's /orders only returns the current day. */
function shapeOrder(o) {
  return {
    order_id: o.order_id,
    parent_order_id: o.parent_order_id || null,
    status: o.status, // COMPLETE | OPEN | CANCELLED | REJECTED | TRIGGER PENDING | ...
    status_message: o.status_message || null,
    tradingsymbol: o.tradingsymbol,
    exchange: o.exchange,
    action: o.transaction_type, // BUY | SELL
    order_type: o.order_type, // MARKET | LIMIT | SL | SL-M
    product: o.product,
    quantity: o.quantity ?? null,
    filled_quantity: o.filled_quantity ?? null,
    pending_quantity: o.pending_quantity ?? null,
    price: o.price ?? null,
    trigger_price: o.trigger_price ?? null,
    average_price: o.average_price ?? null,
    placed_at: o.order_timestamp || null,
    updated_at: o.exchange_update_timestamp || o.order_timestamp || null,
    tag: o.tag || null,
  };
}

/** Today's order book (Kite only keeps the current trading day). */
router.get("/orders", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);
  try {
    const orders = await withKite((kc) => kc.getOrders());
    const shaped = (Array.isArray(orders) ? orders : [])
      .map(shapeOrder)
      .sort((a, b) => new Date(b.placed_at) - new Date(a.placed_at));
    return res.json({ orders: shaped });
  } catch (err) {
    logger.error("Order list failed:", err.message);
    return fail(res, err, "Failed to list orders");
  }
});

/** Executed trades for today. */
router.get("/trades", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);
  try {
    const trades = await withKite((kc) => kc.getTrades());
    return res.json({ trades: Array.isArray(trades) ? trades : [] });
  } catch (err) {
    logger.error("Trade list failed:", err.message);
    return fail(res, err, "Failed to list trades");
  }
});

router.post("/order", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);

  const p = parseTicket(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error, code: "invalid_input" });

  const instrument = `${p.exchange}:${p.tradingsymbol}`;

  try {
    const lastPrice = await fetchLtp(instrument);
    if (!lastPrice) {
      return res.status(404).json({
        error: `${instrument} is not a tradable symbol`,
        code: "invalid_symbol",
      });
    }

    logger.info(
      `Creating GTT pair | ${instrument} | ${p.action} qty=${p.quantity} | ` +
        `entry trig=${p.triggerPrice} @ ${p.limitPrice} | SL=${p.slPrice} target=${p.targetPrice} | ltp=${lastPrice}`
    );

    const entry = await withKite((kc) => kc.placeGTT(entryParams(kc, p, lastPrice)));

    let exit = null;
    let exitError = null;
    try {
      exit = await withKite((kc) => kc.placeGTT(exitParams(kc, p, lastPrice)));
    } catch (err) {
      exitError = err?.response?.data?.message || err.message;
      logger.error("Exit (SL/target) GTT failed after entry placed:", exitError);
    }

    return res.status(exitError ? 207 : 200).json({
      message: exitError
        ? "Entry GTT placed, but the SL/target GTT failed — add it manually"
        : "Entry + SL/target GTTs created",
      entry,
      exit,
      exit_error: exitError,
      order: {
        symbol: instrument,
        action: p.action,
        quantity: p.quantity,
        trigger_price: p.triggerPrice,
        limit_price: p.limitPrice,
        sl_price: p.slPrice,
        target_price: p.targetPrice,
        last_price: lastPrice,
        product: p.product,
      },
    });
  } catch (err) {
    logger.error("GTT creation failed:", err.message);
    return fail(res, err, "GTT creation failed");
  }
});

router.get("/orders/gtt", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);
  try {
    const triggers = await withKite((kc) => kc.getGTTs());
    const shaped = (Array.isArray(triggers) ? triggers : [])
      .map(shapeTrigger)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return res.json({ triggers: shaped });
  } catch (err) {
    logger.error("GTT list failed:", err.message);
    return fail(res, err, "Failed to list GTTs");
  }
});

/**
 * Modify one GTT. The body decides which kind:
 *   sl_price + target_price present → rebuild the OCO exit
 *   otherwise                       → rebuild the single-leg entry
 */
router.put("/orders/gtt/:id", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: "invalid GTT id", code: "invalid_input" });

  const p = parseTicket(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error, code: "invalid_input" });

  const instrument = `${p.exchange}:${p.tradingsymbol}`;
  const asExit = req.body?.kind === "exit";

  try {
    const lastPrice = await fetchLtp(instrument);
    if (!lastPrice) {
      return res.status(404).json({
        error: `${instrument} is not a tradable symbol`,
        code: "invalid_symbol",
      });
    }

    logger.info(`Modifying ${asExit ? "exit" : "entry"} GTT ${id} | ${instrument} | ${p.action}`);

    const gtt = await withKite((kc) =>
      kc.modifyGTT(id, asExit ? exitParams(kc, p, lastPrice) : entryParams(kc, p, lastPrice))
    );
    return res.json({ message: "GTT updated", gtt });
  } catch (err) {
    logger.error("GTT modify failed:", err.message);
    return fail(res, err, "GTT modify failed");
  }
});

router.delete("/orders/gtt/:id", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: "invalid GTT id", code: "invalid_input" });

  try {
    logger.info(`Deleting GTT ${id}`);
    const gtt = await withKite((kc) => kc.deleteGTT(id));
    return res.json({ message: "GTT cancelled", gtt });
  } catch (err) {
    logger.error("GTT delete failed:", err.message);
    return fail(res, err, "GTT delete failed");
  }
});

export default router;
