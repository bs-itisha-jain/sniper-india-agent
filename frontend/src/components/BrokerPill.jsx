import { useBroker } from "../context/BrokerContext.jsx";
import { relative, clockTime } from "../lib/time.js";

const META = {
  checking: { dot: "grey", label: "Connecting…", tone: "" },
  auth: { dot: "amber pulsing", label: "Authenticating…", tone: "st-auth" },
  connected: { dot: "green pulsing", label: "Connected", tone: "st-ok" },
  expired: { dot: "amber", label: "Session expired", tone: "st-warn" },
  down: { dot: "red", label: "Not connected", tone: "st-down" },
};

/** Pure status badge in the header — no click, the ConnectBar handles action. */
export default function BrokerPill() {
  const { phase, status, sch } = useBroker();
  const m = META[phase] || META.checking;

  const tip =
    phase === "connected" && status?.expiresAt
      ? `Token valid until ${clockTime(status.expiresAt)} (${relative(status.expiresAt, {
          future: true,
        })}). Auto-refresh ${
          sch?.nextRun ? clockTime(sch.nextRun) + " IST" : "8:00 AM IST"
        }.`
      : phase === "auth"
        ? "Signing in to Zerodha — prices resume automatically."
        : undefined;

  return (
    <span className={`broker-pill ${m.tone}`} title={tip}>
      <span className={`dot ${m.dot}`} />
      <span className="bp-label">{m.label}</span>
      {phase === "connected" && status?.expiresAt && (
        <span className="bp-sub">· until {clockTime(status.expiresAt)}</span>
      )}
    </span>
  );
}
