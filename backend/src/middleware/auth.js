import jwt from "jsonwebtoken";
import { config } from "../config.js";

export function signToken() {
  return jwt.sign({ sub: config.app.username, role: "user" }, config.app.jwtSecret, {
    expiresIn: config.app.jwtExpiresIn,
  });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    req.user = jwt.verify(token, config.app.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}
