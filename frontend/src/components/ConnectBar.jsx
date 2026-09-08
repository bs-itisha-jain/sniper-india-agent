import { useState } from "react";
import { useBroker } from "../context/BrokerContext.jsx";
import { relative, clockTime } from "../lib/time.js";

const istTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

/**
 * Always-visible strip. When disconnected it's the recovery action; when
 * connected it stays available so the token can be replaced at any time.
 */
export default function ConnectBar() {
  const { phase, status, sch, loginUrl, busy, connect, runAutoConnect } = useBroker();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState(null);

  if (phase === "checking") return null;

  // Automatic login is running — reassure, don't ask for anything.
  if (phase === "auth") {
    return (
      <div className="connbar is-auth">
        <span className="spin" />
        <span className="cb-text">
          Connecting to Zerodha…
          {sch?.retryAt && (
            <span className="cb-dim"> retry {relative(sch.retryAt, { future: true })}</span>
          )}
        </span>
        <span className="cb-dim">You can keep working — prices resume automatically.</span>
      </div>
    );
  }

  const connected = phase === "connected";
  const canAuto = sch && !sch.needsManual && !connected;

  const submit = async (e) => {
    e.preventDefault();
    setMsg(null);
    const r = await connect(value);
    if (r.ok) {
      setValue("");
      setMsg({ type: "ok", text: "Token updated." });
    } else {
      setMsg({ type: "err", text: r.error });
    }
  };

  const tryAuto = async () => {
    setMsg(null);
    const r = await runAutoConnect();
    if (!r.ok) setMsg({ type: "err", text: r.error });
  };

  const tone = connected ? "is-ok" : phase === "expired" ? "is-warn" : "is-down";

  return (
    <div className={`connbar ${tone}`}>
      <div className="cb-lead">
        <span
          className={`dot ${
            connected ? "green pulsing" : phase === "expired" ? "amber" : "red"
          }`}
        />
        <span className="cb-text">
          {connected
            ? "Broker connected"
            : phase === "expired"
              ? "Broker session expired"
              : "Broker not connected"}
        </span>
        <span className="cb-dim">
          {connected
            ? `${status?.zerodhaUser || "Zerodha"} · expires ${clockTime(status?.expiresAt)}` +
              (sch?.nextRun ? ` · auto ${istTime(sch.nextRun)} IST` : "")
            : `auto-refreshes daily at ${sch?.nextRun ? `${istTime(sch.nextRun)} IST` : "8:00 AM IST"}`}
        </span>
      </div>

      {canAuto ? (
        <button className="btn sm" onClick={tryAuto} disabled={busy} type="button">
          {busy ? <span className="spin" /> : "Connect now"}
        </button>
      ) : (
        <form className="cb-form" onSubmit={submit}>
          <input
            className="control sm cb-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={connected ? "paste a new access token" : "paste Zerodha access token"}
            spellCheck="false"
            autoComplete="off"
            autoFocus={!connected}
          />
          <button className="btn sm" type="submit" disabled={busy || !value.trim()}>
            {busy ? <span className="spin" /> : connected ? "Update" : "Connect"}
          </button>
          {loginUrl && (
            <a className="cb-link" href={loginUrl} target="_blank" rel="noopener noreferrer">
              get a token ↗
            </a>
          )}
        </form>
      )}

      {msg && <span className={`cb-msg ${msg.type}`}>{msg.text}</span>}
    </div>
  );
}
