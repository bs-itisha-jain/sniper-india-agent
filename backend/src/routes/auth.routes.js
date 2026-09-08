import { Router } from "express";
import { config } from "../config.js";
import { signToken, requireAuth } from "../middleware/auth.js";

const router = Router();

const cookieOptions = {
  httpOnly: true,
  sameSite: config.nodeEnv === "production" ? "none" : "lax",
  secure: config.nodeEnv === "production",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== config.app.username || password !== config.app.password) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = signToken();
  res.cookie("token", token, cookieOptions);
  res.json({ token, username: config.app.username });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ username: config.app.username });
});

export default router;
