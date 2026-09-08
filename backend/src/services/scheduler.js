import cron from "node-cron";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { generateAccessToken } from "./zerodhaAutoLogin.js";
import {
  saveToken,
  isTokenFresh,
  getToken,
  tokenExpiresAt,
  nextIstBoundary,
} from "./tokenStore.js";

/** Backoff for automatic retries after a failed refresh. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

let lastRun = null;
let lastError = null;
let lastErrorAt = null;
let running = false;
let attempt = 0;
let needsManual = false;
let retryTimer = null;
let retryAt = null;
let inflight = null;

function cancelRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAt = null;
}

function scheduleRetry(reason) {
  if (attempt >= RETRY_DELAYS_MS.length) {
    logger.error(
      `Token refresh gave up after ${attempt} attempts — will try again at the next scheduled run. ` +
        `Use POST /api/token/refresh or the manual request_token flow.`
    );
    return;
  }
  const delay = RETRY_DELAYS_MS[attempt];
  attempt += 1;
  retryAt = new Date(Date.now() + delay).toISOString();
  cancelRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = null;
    refreshToken(`${reason} (retry ${attempt}/${RETRY_DELAYS_MS.length})`);
  }, delay);
  retryTimer.unref?.();
  logger.warn(`Retrying token refresh in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
}

/**
 * Refreshes the shared access token. Concurrent callers join the in-flight
 * attempt instead of starting a second headless login.
 */
export async function refreshToken(reason = "manual") {
  if (inflight) return inflight;

  running = true;
  cancelRetry();
  logger.info(`Refreshing Zerodha access token (${reason})...`);

  inflight = (async () => {
    try {
      const data = await generateAccessToken();
      saveToken(data);
      lastRun = new Date().toISOString();
      lastError = null;
      lastErrorAt = null;
      attempt = 0;
      needsManual = false;
      logger.info("Access token refreshed for", data.user_id);
      return { ok: true, updatedAt: lastRun, user_id: data.user_id };
    } catch (err) {
      lastError = err.message;
      lastErrorAt = new Date().toISOString();
      needsManual = Boolean(err.needsManual);
      logger.error("Token refresh failed:", err.message);
      // Retrying a misconfiguration just burns login attempts — only back off
      // for failures that might actually resolve on their own.
      if (!needsManual) scheduleRetry(reason);
      return { ok: false, error: err.message, needsManual };
    } finally {
      running = false;
      inflight = null;
    }
  })();

  return inflight;
}

/** Records a token obtained out-of-band (manual request_token exchange). */
export function noteManualRefresh() {
  lastRun = new Date().toISOString();
  lastError = null;
  lastErrorAt = null;
  attempt = 0;
  needsManual = false;
  cancelRetry();
}

/** Next fire time for simple `M H * * *` crons; null for complex expressions. */
function nextScheduledRun() {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(config.scheduler.cron.trim());
  if (!m) return null;
  return nextIstBoundary(new Date(), Number(m[2]), Number(m[1])).toISOString();
}

export function schedulerStatus() {
  const expiry = tokenExpiresAt();
  return {
    cron: config.scheduler.cron,
    timezone: config.scheduler.timezone,
    lastRun,
    lastError,
    lastErrorAt,
    running,
    attempt,
    maxAttempts: RETRY_DELAYS_MS.length,
    needsManual,
    retryAt,
    nextRun: nextScheduledRun(),
    expiresAt: expiry ? expiry.toISOString() : null,
  };
}

export function startScheduler() {
  if (!cron.validate(config.scheduler.cron)) {
    logger.error("Invalid TOKEN_REFRESH_CRON:", config.scheduler.cron);
    return;
  }

  cron.schedule(
    config.scheduler.cron,
    () => {
      attempt = 0;
      refreshToken("scheduled daily refresh");
    },
    { timezone: config.scheduler.timezone }
  );
  logger.info(
    `Token refresh scheduled: "${config.scheduler.cron}" (${config.scheduler.timezone})`
  );

  if (!config.scheduler.refreshOnStartup) {
    if (!getToken()?.access_token) {
      logger.warn("No token stored and REFRESH_ON_STARTUP=false — call POST /api/token/refresh");
    }
    return;
  }

  if (isTokenFresh()) {
    logger.info(
      `Stored token valid until ${tokenExpiresAt().toISOString()} — skipping startup refresh`
    );
  } else {
    logger.info("Stored token missing or expired — refreshing on startup");
    refreshToken("startup");
  }
}
