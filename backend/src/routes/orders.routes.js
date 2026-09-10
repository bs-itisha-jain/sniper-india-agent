import { Router } from "express";
import { withKite, hasAccessToken, classifyKiteError } from "../services/kiteClient.js";
import { logger } from "../logger.js";

const router = Router();

const PRODUCTS = new Set(["CNC", "MIS"]);

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

/** Normalise a leg's transaction type + validate the single-leg GTT inputs. */
function parseLeg(body) {
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const action = String(body.action || "").trim().toUpperCase();
  const product = String(body.product || "CNC").trim().toUpperCase();
  const quantity = Number(body.quantity);
  const triggerPrice = Number(body.trigger_price);
  const price = Number(body.price);

  if (!symbol) return { error: "symbol is required" };
  if (!["BUY", "SELL"].includes(action)) return { error: "action must be BUY or SELL" };
  if (!Number.isInteger(quantity) || quantity <= 0)
    return { error: "quantity must be a positive integer" };
  if (!(triggerPrice > 0)) return { error: "trigger_price must be a positive number" };
  if (!(price > 0)) return { error: "price must be a positive number" };
  if (!PRODUCTS.has(product)) return { error: "product must be CNC or MIS" };

  const [exchange, tradingsymbol] = symbol.includes(":")
    ? symbol.split(":")
    : ["NSE", symbol];

  return { exchange, tradingsymbol, action, product, quantity, triggerPrice, price };
}

/** Flatten Kite's GTT object into what the UI needs (single-leg or two-leg OCO). */
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
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    expires_at: t.expires_at || null,
  };

  if (t.type === "two-leg" && legs.length === 2 && triggers.length === 2) {
    const exit = legs[0]?.transaction_type || null; // SELL exits a long, BUY exits a short
    const isLong = exit === "SELL";
    const [loTrig, hiTrig] = triggers;
    const [loLeg, hiLeg] = legs;
    const slLeg = isLong ? loLeg : hiLeg;
    const targetLeg = isLong ? hiLeg : loLeg;
    return {
      ...base,
      kind: "exit",
      exit_action: exit,
      action: isLong ? "BUY" : "SELL", // the position being protected
      sl_price: isLong ? loTrig : hiTrig,
      sl_limit: slLeg?.price ?? null,
      sl_quantity: slLeg?.quantity ?? null,
      target_price: isLong ? hiTrig : loTrig,
      target_limit: targetLeg?.price ?? null,
      target_quantity: targetLeg?.quantity ?? null,
      quantity: targetLeg?.quantity ?? null,
    };
  }

  const leg = legs[0] || {};
  return {
    ...base,
    kind: "entry",
    action: leg.transaction_type || null,
    quantity: leg.quantity ?? null,
    trigger_price: triggers[0] ?? null,
    limit_price: leg.price ?? null,
  };
}

/** Flatten a Kite order-book row. Kite's /orders only returns the current day. */
function shapeOrder(o) {
  return {
    order_id: o.order_id,
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
    average_price: o.average_price ?? null, // the fill price — SL/target are computed off this
    placed_at: o.order_timestamp || null,
    updated_at: o.exchange_update_timestamp || o.order_timestamp || null,
    tag: o.tag || null,
  };
}

router.post("/order", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);

  const parsed = parseLeg(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error, code: "invalid_input" });

  const { exchange, tradingsymbol, action, product, quantity, triggerPrice, price } = parsed;
  const instrument = `${exchange}:${tradingsymbol}`;

  try {
    // GTT requires the current price as a reference; fetch it fresh.
    const ltpResponse = await withKite((kc) => kc.getLTP([instrument]));
    const lastPrice = Number(ltpResponse?.[instrument]?.last_price);
    if (!lastPrice) {
      return res.status(404).json({
        error: `${instrument} is not a tradable symbol`,
        code: "invalid_symbol",
      });
    }

    logger.info(
      `Creating GTT | ${instrument} | ${action} | qty=${quantity} | trigger=${triggerPrice} | price=${price} | ltp=${lastPrice}`
    );

    const gtt = await withKite((kc) =>
      kc.placeGTT({
        trigger_type: kc.GTT_TYPE_SINGLE,
        tradingsymbol,
        exchange,
        trigger_values: [triggerPrice],
        last_price: lastPrice,
        orders: [
          {
            transaction_type:
              action === "BUY" ? kc.TRANSACTION_TYPE_BUY : kc.TRANSACTION_TYPE_SELL,
            quantity,
            order_type: kc.ORDER_TYPE_LIMIT,
            product,
            price,
          },
        ],
      })
    );

    return res.json({
      message: "GTT created successfully",
      gtt,
      order: {
        symbol: instrument,
        action,
        quantity,
        trigger_price: triggerPrice,
        limit_price: price,
        last_price: lastPrice,
        product,
      },
    });
  } catch (err) {
    logger.error("GTT creation failed:", err.message);
    return fail(res, err, "GTT creation failed");
  }
});

/**
 * Today's order book. `?status=complete` returns only filled orders — the
 * entries an exit GTT (SL + target) gets armed against.
 */
router.get("/orders", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);
  try {
    const orders = await withKite((kc) => kc.getOrders());
    let shaped = (Array.isArray(orders) ? orders : []).map(shapeOrder);
    if (String(req.query.status || "").toLowerCase() === "complete") {
      shaped = shaped.filter((o) => o.status === "COMPLETE");
    }
    shaped.sort((a, b) => new Date(b.placed_at) - new Date(a.placed_at));
    return res.json({ orders: shaped });
  } catch (err) {
    logger.error("Order list failed:", err.message);
    return fail(res, err, "Failed to list orders");
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

router.put("/orders/gtt/:id", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: "invalid GTT id", code: "invalid_input" });

  const parsed = parseLeg(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error, code: "invalid_input" });

  const { exchange, tradingsymbol, action, product, quantity, triggerPrice, price } = parsed;
  const instrument = `${exchange}:${tradingsymbol}`;

  try {
    const ltpResponse = await withKite((kc) => kc.getLTP([instrument]));
    const lastPrice = Number(ltpResponse?.[instrument]?.last_price);
    if (!lastPrice) {
      return res.status(404).json({
        error: `${instrument} is not a tradable symbol`,
        code: "invalid_symbol",
      });
    }

    logger.info(`Modifying GTT ${id} | ${instrument} | ${action} qty=${quantity} trig=${triggerPrice} @ ${price}`);

    const gtt = await withKite((kc) =>
      kc.modifyGTT(id, {
        trigger_type: kc.GTT_TYPE_SINGLE,
        tradingsymbol,
        exchange,
        trigger_values: [triggerPrice],
        last_price: lastPrice,
        orders: [
          {
            transaction_type:
              action === "BUY" ? kc.TRANSACTION_TYPE_BUY : kc.TRANSACTION_TYPE_SELL,
            quantity,
            order_type: kc.ORDER_TYPE_LIMIT,
            product,
            price,
          },
        ],
      })
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
