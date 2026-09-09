import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { logger } from "../logger.js";

const filePath = path.resolve(process.cwd(), config.tokenFile);

/**
 * Zerodha invalidates every access token at ~07:30 IST each morning,
 * regardless of when it was issued. India has no DST, so a fixed
 * +05:30 offset is exact.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
const EXPIRY_IST_HOUR = 7;
const EXPIRY_IST_MINUTE = 30;

let cache = null;

export function getToken() {
  if (cache) return cache;
  try {
    if (fs.existsSync(filePath)) {
      cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    logger.error("Failed to read token file:", err.message);
  }
  return cache;
}

export function saveToken(data) {
  cache = { ...data, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
    logger.info("Access token persisted to", filePath);
  } catch (err) {
    logger.error("Failed to persist token file:", err.message);
  }
  return cache;
}

/** The next 07:30 IST strictly after `from`. */
function nextIstBoundary(from = new Date()) {
  const ist = new Date(from.getTime() + IST_OFFSET_MS);
  let boundary = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
    EXPIRY_IST_HOUR,
    EXPIRY_IST_MINUTE,
    0,
    0
  );
  if (boundary <= ist.getTime()) boundary += 24 * 60 * 60 * 1000;
  return new Date(boundary - IST_OFFSET_MS);
}

/**
 * When the currently stored token stops working. Survives restarts and
 * reboots because it is derived from the persisted issue time, not uptime.
 */
export function tokenExpiresAt() {
  const token = getToken();
  if (!token?.access_token || !token?.updatedAt) return null;
  return nextIstBoundary(new Date(token.updatedAt));
}

export function isTokenFresh() {
  const expiry = tokenExpiresAt();
  return Boolean(expiry) && Date.now() < expiry.getTime();
}
