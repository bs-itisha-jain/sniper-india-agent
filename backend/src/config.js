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

  kite: {
    apiKey: required("KITE_API_KEY"),
    apiSecret: required("KITE_API_SECRET"),
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
