import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { config, warnMissingConfig } from "./config.js";
import { logger } from "./logger.js";
import { requireAuth } from "./middleware/auth.js";
import { startScheduler } from "./services/scheduler.js";

import authRoutes from "./routes/auth.routes.js";
import marketRoutes from "./routes/market.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import tokenRoutes from "./routes/token.routes.js";

warnMissingConfig(logger);

const app = express();

app.set("trust proxy", 1);
app.use(
  cors({
    origin: config.corsOrigin.includes("*") ? true : config.corsOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/health", (req, res) => {
  res.json({ status: "ok", env: config.nodeEnv, time: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);

// Everything below requires the shared app login
app.use("/api", requireAuth, tokenRoutes);
app.use("/api", requireAuth, marketRoutes);
app.use("/api", requireAuth, ordersRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(err.stack || err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  logger.info(`Backend listening on http://localhost:${config.port} (${config.nodeEnv})`);
  startScheduler();
});
