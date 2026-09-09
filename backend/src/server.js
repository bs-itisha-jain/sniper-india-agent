import express from "express";
import cors from "cors";

import { config, warnMissingConfig } from "./config.js";
import { logger } from "./logger.js";
import { startScheduler } from "./services/scheduler.js";

import marketRoutes from "./routes/market.routes.js";
import ordersRoutes from "./routes/orders.routes.js";
import tokenRoutes from "./routes/token.routes.js";

warnMissingConfig(logger);

const app = express();

app.set("trust proxy", 1);
app.use(
  cors({
    origin: config.corsOrigin.includes("*") ? true : config.corsOrigin,
  })
);
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", env: config.nodeEnv, time: new Date().toISOString() });
});

app.use("/api", tokenRoutes);
app.use("/api", marketRoutes);
app.use("/api", ordersRoutes);

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
