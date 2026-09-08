import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { authenticator } from "otplib";
import pkg from "kiteconnect";
import { config } from "../config.js";
import { logger } from "../logger.js";

const { KiteConnect } = pkg;

const KITE_WEB = "https://kite.zerodha.com";

function form(obj) {
  return new URLSearchParams(obj).toString();
}

const BASE32 = /^[A-Z2-7]+=*$/;
const PLACEHOLDER = /^(your_|change-me|replace-with|dev-only)/i;

/** TOTP seeds are often shown space-separated and lower-cased. */
function normaliseSecret(raw) {
  return String(raw || "").replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Returns a reason string when automatic login must not be attempted, or null
 * when every credential looks real. otplib happily derives a valid-looking code
 * from nonsense (e.g. "your_base32_totp_secret" -> 488008), so the seed has to
 * be validated here rather than relied on to throw.
 */
function preflight({ userId, password, totpSecret, apiKey, apiSecret }) {
  const missing = [];
  if (!userId) missing.push("ZERODHA_USER_ID");
  if (!password) missing.push("ZERODHA_PASSWORD");
  if (!totpSecret) missing.push("ZERODHA_TOTP_SECRET");
  if (!apiKey) missing.push("KITE_API_KEY");
  if (!apiSecret) missing.push("KITE_API_SECRET");
  if (missing.length) {
    return `Automatic login disabled — not configured: ${missing.join(", ")}. Use the manual request_token flow.`;
  }

  const placeholders = Object.entries({
    ZERODHA_USER_ID: userId,
    ZERODHA_PASSWORD: password,
    ZERODHA_TOTP_SECRET: totpSecret,
    KITE_API_KEY: apiKey,
    KITE_API_SECRET: apiSecret,
  })
    .filter(([, v]) => PLACEHOLDER.test(v))
    .map(([k]) => k);
  if (placeholders.length) {
    return `Automatic login disabled — still placeholder values: ${placeholders.join(", ")}. Use the manual request_token flow.`;
  }

  if (!BASE32.test(normaliseSecret(totpSecret))) {
    return (
      "Automatic login disabled — ZERODHA_TOTP_SECRET is not valid base32. " +
      "Enable External TOTP in the Kite console and paste the secret it shows, " +
      "or use the manual request_token flow. (No login was attempted: a wrong " +
      "2FA code risks locking the account.)"
    );
  }

  return null;
}

/** Zerodha explains failures in the JSON body; axios only says "status code 400". */
function zerodhaMessage(err, fallback) {
  const body = err?.response?.data;
  const detail = body?.message || body?.error_type;
  if (detail) return `${fallback}: ${detail}`;
  return `${fallback}: ${err.message}`;
}

/** The URL a human opens to log in by hand (Python's `--login` step). */
export function getLoginUrl() {
  const { apiKey } = config.kite;
  if (!apiKey) throw new Error("KITE_API_KEY is not configured");
  return `${KITE_WEB}/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
}

/**
 * Exchanges a request_token captured from the Kite redirect for an
 * access_token (Python's `--request-token` step). The manual fallback
 * for when the headless login cannot complete on its own.
 */
export async function exchangeRequestToken(requestToken) {
  const { apiKey, apiSecret } = config.kite;
  if (!apiKey || !apiSecret) {
    throw new Error("KITE_API_KEY and KITE_API_SECRET must be configured");
  }
  const kc = new KiteConnect({ api_key: apiKey });
  const session = await kc.generateSession(requestToken, apiSecret);
  if (!session?.access_token) {
    throw new Error("generateSession() did not return an access_token");
  }
  return {
    access_token: session.access_token,
    public_token: session.public_token || null,
    login_time: session.login_time || null,
    user_id: session.user_id || null,
  };
}

/**
 * Performs a headless Zerodha login (password + TOTP 2FA), captures the
 * request_token from the Kite Connect redirect, then exchanges it for a
 * long-lived access_token via the Kite Connect API.
 */
export async function generateAccessToken() {
  const { userId, password, totpSecret } = config.zerodha;
  const { apiKey, apiSecret } = config.kite;

  // Refuse to touch the network unless every credential is real. A wrong TOTP
  // counts as a failed 2FA attempt against a live account, and enough of those
  // get the account locked — never send one speculatively.
  const blocked = preflight({ userId, password, totpSecret, apiKey, apiSecret });
  if (blocked) {
    const err = new Error(blocked);
    err.needsManual = true;
    throw err;
  }

  const secret = normaliseSecret(totpSecret);

  const jar = new CookieJar();
  const http = wrapper(
    axios.create({
      jar,
      baseURL: KITE_WEB,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "X-Kite-Version": "3",
      },
    })
  );

  // Step 1 — username + password
  let loginRes;
  try {
    loginRes = await http.post("/api/login", form({ user_id: userId, password }));
  } catch (err) {
    throw new Error(zerodhaMessage(err, "Password login rejected by Zerodha"));
  }
  const requestId = loginRes.data?.data?.request_id;
  if (!requestId) {
    throw new Error("Password login failed — no request_id returned by Zerodha");
  }

  // Step 2 — TOTP 2FA
  const totp = authenticator.generate(secret);
  try {
    await http.post(
      "/api/twofa",
      form({
        user_id: userId,
        request_id: requestId,
        twofa_value: totp,
        twofa_type: "totp",
      })
    );
  } catch (err) {
    // A rejected 2FA code never fixes itself, and each retry is another failed
    // attempt against a live account. Stop here and hand over to the manual flow.
    const failure = new Error(zerodhaMessage(err, "TOTP 2FA rejected by Zerodha"));
    failure.needsManual = true;
    throw failure;
  }
  logger.info("Zerodha 2FA (TOTP) accepted");

  // Step 3 — capture request_token from the Kite Connect login redirect
  const requestToken = await captureRequestToken(http, apiKey);
  if (!requestToken) {
    const err = new Error(
      "Could not capture request_token — Zerodha may be asking for extra confirmation. " +
        "Use the manual request_token flow, or check the app's redirect URL in the Kite console."
    );
    err.needsManual = true;
    throw err;
  }

  // Step 4 — exchange request_token for an access_token
  const session = await exchangeRequestToken(requestToken);
  logger.info("New Zerodha access token generated for", session.user_id);
  return { ...session, user_id: session.user_id || userId };
}

async function captureRequestToken(http, apiKey) {
  let url = `/connect/login?api_key=${apiKey}&v=3`;

  for (let hop = 0; hop < 8; hop++) {
    let res;
    try {
      res = await http.get(url);
    } catch (err) {
      if (!err.response) throw err;
      res = err.response;
    }

    const location = res.headers?.location || "";
    const match = /request_token=([A-Za-z0-9._-]+)/.exec(location || url);
    if (match) return match[1];

    if (!location) return null;
    url = location.startsWith("http")
      ? location.replace(KITE_WEB, "")
      : location;
  }
  return null;
}
