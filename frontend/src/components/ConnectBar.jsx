import { useState } from "react";
import { useBroker } from "../context/BrokerContext.jsx";
import { clockTime } from "../lib/time.js";

/**
 * Always-visible strip. When disconnected it's the recovery action; when
 * connected it stays available so the token can be replaced at any time.
 */
export default function ConnectBar() {
  const { phase, status, loginUrl, busy, connect } = useBroker();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState(null);

  if (phase === "checking") return null;

  const connected = phase === "connected";

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
            ? `${status?.zerodhaUser || "Zerodha"} · expires ${clockTime(status?.expiresAt)}`
            : "Log in on Kite, then paste the request token from the redirect URL — new one each day"}
        </span>
      </div>

      <form className="cb-form" onSubmit={submit}>
        <input
          className="control sm cb-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            connected ? "paste a new request token" : "paste request token or Kite redirect URL"
          }
          spellCheck="false"
          autoComplete="off"
          autoFocus={!connected}
        />
        <button className="btn sm" type="submit" disabled={busy || !value.trim()}>
          {busy ? <span className="spin" /> : connected ? "Update" : "Connect"}
        </button>
        {loginUrl && (
          <a className="cb-link" href={loginUrl} target="_blank" rel="noopener noreferrer">
            log in on Kite ↗
          </a>
        )}
      </form>

      {msg && <span className={`cb-msg ${msg.type}`}>{msg.text}</span>}
    </div>
  );
}
