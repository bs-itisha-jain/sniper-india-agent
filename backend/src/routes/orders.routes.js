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
 * Validate a two-leg OCO GTT request.
 *
 * `action` is the position being protected:
 *   BUY  → you are long  → both exit legs SELL; SL below entry, target above
 *   SELL → you are short → both exit legs BUY;  SL above entry, target below
 */
function parseOco(body) {
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const action = String(body.action || "").trim().toUpperCase();
  const product = String(body.product || "CNC").trim().toUpperCase();
  const quantity = Number(body.quantity);
  const limitPrice = Number(body.limit_price);
  const slPrice = Number(body.sl_price);
  const targetPrice = Number(body.target_price);

  if (!symbol) return { error: "symbol is required" };
  if (!["BUY", "SELL"].includes(action)) return { error: "action must be BUY or SELL" };
  if (!Number.isInteger(quantity) || quantity <= 0)
    return { error: "quantity must be a positive integer" };
  if (!(limitPrice > 0)) return { error: "limit_price must be a positive number" };
  if (!(slPrice > 0)) return { error: "sl_price must be a positive number" };
  if (!(targetPrice > 0)) return { error: "target_price must be a positive number" };
  if (!PRODUCTS.has(product)) return { error: "product must be CNC, MIS or NRML" };

  if (action === "BUY") {
    if (!(slPrice < limitPrice))
      return { error: "for a BUY position the stop-loss must be below the limit price" };
    if (!(targetPrice > limitPrice))
      return { error: "for a BUY position the target must be above the limit price" };
  } else {
    if (!(slPrice > limitPrice))
      return { error: "for a SELL position the stop-loss must be above the limit price" };
    if (!(targetPrice < limitPrice))
      return { error: "for a SELL position the target must be below the limit price" };
  }

  const [exchange, tradingsymbol] = symbol.includes(":")
    ? symbol.split(":")
    : ["NSE", symbol];

  const exitType = action === "BUY" ? "SELL" : "BUY";
  const lower = round2(Math.min(slPrice, targetPrice));
  const upper = round2(Math.max(slPrice, targetPrice));

  return {
    exchange,
    tradingsymbol,
    action,
    product,
    quantity,
    limitPrice: round2(limitPrice),
    slPrice: round2(slPrice),
    targetPrice: round2(targetPrice),
    exitType,
    lower,
    upper,
  };
}

/** Build the OCO placeGTT / modifyGTT params. */
function ocoParams(kc, p, lastPrice) {
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
    // exit SELL → position was BUY → lower trigger is the SL, upper is the target
    const isLong = exit === "SELL";
    return {
      ...base,
      action: isLong ? "BUY" : "SELL", // the position being protected
      sl_price: isLong ? lo : hi,
      target_price: isLong ? hi : lo,
      sl_limit: isLong ? loLeg?.price ?? null : hiLeg?.price ?? null,
      target_limit: isLong ? hiLeg?.price ?? null : loLeg?.price ?? null,
      limit_price: round2((lo + hi) / 2), // entry sits midway between SL and target
    };
  }

  // legacy single-leg GTT
  return {
    ...base,
    action: legs[0]?.transaction_type || null,
    trigger_price: triggers[0] ?? null,
    limit_price: legs[0]?.price ?? null,
  };
}

async function fetchLtp(instrument) {
  const ltpResponse = await withKite((kc) => kc.getLTP([instrument]));
  return Number(ltpResponse?.[instrument]?.last_price);
}

router.post("/order", async (req, res) => {
  if (!hasAccessToken()) return noToken(res);

  const p = parseOco(req.body || {});
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
      `Creating OCO GTT | ${instrument} | protect ${p.action} | qty=${p.quantity} | ` +
        `SL=${p.slPrice} target=${p.targetPrice} | ltp=${lastPrice}`
    );

    const gtt = await withKite((kc) => kc.placeGTT(ocoParams(kc, p, lastPrice)));

    return res.json({
      message: "OCO GTT created successfully",
      gtt,
      order: {
        symbol: instrument,
        action: p.action,
        quantity: p.quantity,
        limit_price: p.limitPrice,
        sl_price: p.slPrice,
        target_price: p.targetPrice,
        last_price: lastPrice,
        product: p.product,
      },
    });
  } catch (err) {
    logger.error("OCO GTT creation failed:", err.message);
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

  const p = parseOco(req.body || {});
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
      `Modifying OCO GTT ${id} | ${instrument} | protect ${p.action} qty=${p.quantity} ` +
        `SL=${p.slPrice} target=${p.targetPrice}`
    );

    const gtt = await withKite((kc) => kc.modifyGTT(id, ocoParams(kc, p, lastPrice)));
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
