import { Router } from "express";
import { withKite, hasAccessToken, classifyKiteError } from "../services/kiteClient.js";
import { logger } from "../logger.js";

const router = Router();

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

function toInstrument(symbol) {
  const s = symbol.trim().toUpperCase();
  return s.includes(":") ? s : `NSE:${s}`;
}

router.get("/ltp", async (req, res) => {
  if (!hasAccessToken()) {
    return res.status(503).json({
      error: "Zerodha access token not available yet",
      code: "no_token",
    });
  }

  const symbol = String(req.query.symbol || "").trim();
  if (!symbol) {
    return res
      .status(400)
      .json({ error: "symbol query parameter is required", code: "invalid_input" });
  }

  const instrument = toInstrument(symbol);

  try {
    const data = await withKite((kc) => kc.getLTP([instrument]));
    const row = data?.[instrument];
    if (!row) {
      // Kite answers with an empty map for symbols it does not know.
      return res.status(404).json({
        error: `${instrument} is not a tradable symbol`,
        code: "invalid_symbol",
      });
    }
    return res.json({
      symbol: instrument,
      last_price: row.last_price,
      fetchedAt: new Date().toISOString(),
      data: row,
    });
  } catch (err) {
    logger.error("LTP fetch failed:", err.message);
    return fail(res, err, "Failed to fetch LTP");
  }
});

export default router;
