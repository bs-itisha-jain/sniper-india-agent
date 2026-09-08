/**
 * One-off CLI token refresh: `npm run refresh-token`
 * Useful for cron on a bare VPS or for a manual first run.
 */
import { refreshToken } from "../services/scheduler.js";

const result = await refreshToken("cli script");
if (result.ok) {
  console.log("OK - token refreshed at", result.updatedAt);
  process.exit(0);
} else {
  console.error("FAILED -", result.error);
  process.exit(1);
}
