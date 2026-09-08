import dotenv from "dotenv";

dotenv.config();

const missing = [];

function required(name) {
  const value = process.env[name];
  if (!value) missing.push(name);
  return value || "";
}

export const config = {
  port: parseInt(process.env.PORT || "5000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  app: {
    username: required("APP_USERNAME"),
    password: required("APP_PASSWORD"),
    jwtSecret: required("JWT_SECRET"),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  },

  kite: {
    apiKey: required("KITE_API_KEY"),
    apiSecret: required("KITE_API_SECRET"),
  },

  zerodha: {
    userId: required("ZERODHA_USER_ID"),
    password: required("ZERODHA_PASSWORD"),
    totpSecret: required("ZERODHA_TOTP_SECRET"),
  },

  scheduler: {
    cron: process.env.TOKEN_REFRESH_CRON || "0 8 * * *",
    timezone: process.env.TZ || "Asia/Kolkata",
    refreshOnStartup: process.env.REFRESH_ON_STARTUP !== "false",
  },

  tokenFile: process.env.TOKEN_FILE || "./data/token.json",
};

export function warnMissingConfig(logger) {
  if (missing.length) {
    logger.warn(
      `Missing/empty env vars: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill them in.`
    );
  }
}
