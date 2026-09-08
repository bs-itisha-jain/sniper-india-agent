import pkg from "kiteconnect";
import { config } from "../config.js";
import { getToken } from "./tokenStore.js";
import { refreshToken } from "./scheduler.js";
import { logger } from "../logger.js";

const { KiteConnect } = pkg;

/**
 * Returns a KiteConnect instance bound to the currently stored shared
 * access token. A fresh instance per request keeps things stateless.
 */
function getKite() {
  const kc = new KiteConnect({ api_key: config.kite.apiKey });
  const token = getToken();
  if (token?.access_token) {
    kc.setAccessToken(token.access_token);
  }
  return kc;
}

export function hasAccessToken() {
  return Boolean(getToken()?.access_token);
}

/** Maps a Kite/transport failure onto a stable code the UI can branch on. */
export function classifyKiteError(err) {
  const type = err?.error_type || err?.errorType || "";
  const msg = err?.message || String(err || "");

  if (type === "TokenException" || /api_key|access_token|token.*expired/i.test(msg)) {
    return "token_expired";
  }
  if (
    type === "NetworkException" ||
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(msg)
  ) {
    return "connection";
  }
  if (type === "InputException") return "invalid_input";
  if (type === "PermissionException") return "forbidden";
  return "api_error";
}

/**
 * Runs a Kite call. If the shared token died mid-session (Zerodha expires it
 * every morning), transparently refreshes once and replays the call so the
 * user never sees a spurious failure.
 */
export async function withKite(fn) {
  try {
    return await fn(getKite());
  } catch (err) {
    if (classifyKiteError(err) !== "token_expired") throw err;

    logger.warn("Kite rejected the stored token — refreshing and retrying once");
    const result = await refreshToken("token rejected mid-session");
    if (!result.ok) {
      const wrapped = new Error(
        "Zerodha session expired and automatic re-login failed: " + result.error
      );
      wrapped.error_type = "TokenException";
      throw wrapped;
    }
    return await fn(getKite());
  }
}
