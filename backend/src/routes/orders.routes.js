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
  if (!PRODUCTS.has(product)) return { error: "product must be CNC, MIS or NRML" };

  const [exchange, tradingsymbol] = symbol.includes(":")
    ? symbol.split(":")
    : ["NSE", symbol];

  return { exchange, tradingsymbol, action, product, quantity, triggerPrice, price };
}

/** Flatten Kite's GTT object into what the UI needs. */
function shapeTrigger(t) {
  const leg = t.orders?.[0] || {};
  return {
    id: t.id,
    status: t.status, // active | triggered | disabled | expired | cancelled | rejected | deleted
    type: t.type, // single | two-leg
    tradingsymbol: t.condition?.tradingsymbol,
    exchange: t.condition?.exchange,
    trigger_price: t.condition?.trigger_values?.[0] ?? null,
    reference_price: t.condition?.last_price ?? null,
    action: leg.transaction_type || null,
    quantity: leg.quantity ?? null,
    limit_price: leg.price ?? null,
    product: leg.product || null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    expires_at: t.expires_at || null,
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
