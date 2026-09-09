import { Router } from "express";
import pkg from "kiteconnect";
import { config } from "../config.js";
import { getToken, isTokenFresh, saveToken, tokenExpiresAt } from "../services/tokenStore.js";
import { getLoginUrl, exchangeRequestToken } from "../services/kiteAuth.js";
import { logger } from "../logger.js";

const { KiteConnect } = pkg;

const router = Router();

/**
 * Token metadata only — the access_token itself is never sent to the browser.
 * Zerodha invalidates every token at ~07:30 IST daily, so `fresh` flips to
 * false each morning and a new one must be pasted.
 */
router.get("/token/status", (req, res) => {
  const token = getToken();
  const expiry = tokenExpiresAt();
  res.json({
    hasToken: Boolean(token?.access_token),
    fresh: isTokenFresh(),
    updatedAt: token?.updatedAt || null,
    expiresAt: expiry ? expiry.toISOString() : null,
    zerodhaUser: token?.user_id || null,
  });
});

/** The URL a human opens to log in by hand; the redirect carries the request_token. */
router.get("/token/login-url", (req, res) => {
  try {
    res.json({ loginUrl: getLoginUrl() });
  } catch (err) {
    res.status(400).json({ error: err.message, code: "invalid_input" });
  }
});

/** Paste the Kite login redirect URL (or the request_token from it). */
router.post("/token/manual", async (req, res) => {
  const requestToken = String(req.body?.request_token || "").trim();
  if (!requestToken) {
    return res.status(400).json({
      error: "request_token is required — copy it from the Kite redirect URL",
      code: "invalid_input",
    });
  }

  try {
    const session = await exchangeRequestToken(requestToken);
    saveToken(session);
    logger.info("Access token set via request_token for", session.user_id);
    return res.json({ ok: true, user_id: session.user_id });
  } catch (err) {
    const detail = err?.response?.data?.message || err.message;
    logger.error("request_token exchange failed:", detail);
    return res.status(502).json({
      ok: false,
      error: `Could not exchange that request_token: ${detail}`,
      code: "api_error",
    });
  }
});

/**
 * Paste an access_token directly. Verified against Kite before it is stored,
 * so a typo or an expired token is rejected loudly instead of silently
 * breaking every later call.
 */
router.post("/token/set", async (req, res) => {
  const accessToken = String(req.body?.access_token || "").trim();
  if (!accessToken) {
    return res.status(400).json({
      error: "access_token is required",
      code: "invalid_input",
    });
  }
  if (!config.kite.apiKey) {
    return res.status(400).json({
      error: "KITE_API_KEY is not configured in the backend",
      code: "invalid_input",
    });
  }

  try {
    const kc = new KiteConnect({ api_key: config.kite.apiKey });
    kc.setAccessToken(accessToken);
    const profile = await kc.getProfile(); // 401s if the token is bad/expired

    saveToken({
      access_token: accessToken,
      user_id: profile?.user_id || null,
      login_time: new Date().toISOString(),
      source: "pasted",
    });
    logger.info("Access token set by paste for", profile?.user_id);
    return res.json({ ok: true, user_id: profile?.user_id || null });
  } catch (err) {
    const detail = err?.response?.data?.message || err.message;
    logger.error("Pasted access token rejected:", detail);
    return res.status(400).json({
      ok: false,
      error: `Zerodha rejected that access token: ${detail}`,
      code: "token_expired",
    });
  }
});

export default router;
