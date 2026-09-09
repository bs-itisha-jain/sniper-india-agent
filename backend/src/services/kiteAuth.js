import pkg from "kiteconnect";
import { config } from "../config.js";

const { KiteConnect } = pkg;

const KITE_WEB = "https://kite.zerodha.com";

/** The URL a human opens to log in by hand. Lands on a redirect that carries request_token. */
export function getLoginUrl() {
  const { apiKey } = config.kite;
  if (!apiKey) throw new Error("KITE_API_KEY is not configured");
  return `${KITE_WEB}/connect/login?api_key=${encodeURIComponent(apiKey)}&v=3`;
}

/**
 * Exchanges a request_token (from the Kite login redirect) for a long-lived
 * access_token via the Kite Connect API.
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
