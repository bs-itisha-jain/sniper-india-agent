import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

const POLL_MS = 15_000;
const STALE_AFTER_MS = 45_000; // no successful fetch in this long → price is stale

const fmt = (n) =>
  Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Short, human copy for every failure mode the API can report. */
const FAILURES = {
  invalid_symbol: "Not a tradable symbol",
  no_token: "No Zerodha session",
  token_expired: "Session expired",
  connection: "Zerodha unreachable",
  offline: "Backend unreachable",
  api_error: "Price unavailable",
};

export default function TargetCard({ instrument, onLtp, onStale }) {
  const [price, setPrice] = useState(null);
  const [dir, setDir] = useState(null);
  const [flash, setFlash] = useState(false);
  const [at, setAt] = useState(null);
  const [failure, setFailure] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | loading | polling | ok | failed
  const [, tick] = useState(0);
  const prev = useRef(null);
  const okAt = useRef(0);

  const key = instrument ? `${instrument.exchange}:${instrument.tradingsymbol}` : null;

  const fetchLtp = useCallback(
    async (background = false) => {
      if (!key) return;
      setPhase(background ? "polling" : "loading");
      try {
        const data = await api.ltp(key);
        const next = Number(data.last_price);
        if (prev.current != null && next !== prev.current) {
          setDir(next > prev.current ? "up" : "down");
          setFlash(true);
          setTimeout(() => setFlash(false), 700);
        }
        prev.current = next;
        okAt.current = Date.now();
        setPrice(next);
        setAt(new Date(data.fetchedAt || Date.now()));
        setFailure(null);
        setPhase("ok");
        onLtp?.(next);
        onStale?.(false);
      } catch (err) {
        setFailure({ code: err.code || "api_error", message: err.message });
        setPhase("failed");
        if (!background) {
          setPrice(null);
          prev.current = null;
          okAt.current = 0;
          onLtp?.(null);
        }
      }
    },
    [key, onLtp, onStale]
  );

  // Mark the price stale if no successful fetch lands for a while.
  useEffect(() => {
    if (!key) return undefined;
    const id = setInterval(() => {
      tick((n) => n + 1);
      if (okAt.current && Date.now() - okAt.current > STALE_AFTER_MS) onStale?.(true);
    }, 5000);
    return () => clearInterval(id);
  }, [key, onStale]);

  // Fetch the moment an instrument is locked in — no extra click.
  useEffect(() => {
    prev.current = null;
    okAt.current = 0;
    setPrice(null);
    setDir(null);
    setFailure(null);
    setPhase("idle");
    onStale?.(false);
    if (key) fetchLtp(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Keep it live, but never poll a dead symbol or a hidden tab.
  useEffect(() => {
    if (!key || phase === "idle") return undefined;
    if (failure?.code === "invalid_symbol") return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fetchLtp(true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [key, phase, failure, fetchLtp]);

  if (!instrument) {
    return (
      <div className="price-panel is-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        </svg>
        <p>Search, then press ↵ to pull the live price</p>
      </div>
    );
  }

  const busy = phase === "loading";
  const hardFail = phase === "failed" && price == null;
  const stale = price != null && okAt.current > 0 && Date.now() - okAt.current > STALE_AFTER_MS;

  return (
    <div className={`price-panel ${hardFail ? "is-failed" : ""} ${stale ? "is-stale" : ""}`}>
      <div className="pp-head">
        <div className="pp-id">
          <div className="pp-name">{instrument.tradingsymbol}</div>
          <div className="pp-meta">
            {instrument.exchange}
            {instrument.synthetic && " · typed"}
          </div>
        </div>
        <button
          className="pp-refresh"
          onClick={() => fetchLtp(false)}
          disabled={busy}
          type="button"
          title="Refresh price"
        >
          {busy ? <span className="spin" /> : "↻"}
        </button>
      </div>

      <div className={`pp-price ${dir || ""}`}>
        {price != null ? (
          <span className={`lp ${flash ? "flash" : ""}`}>
            <span className="cur">₹</span>
            {fmt(price)}
          </span>
        ) : busy ? (
          <span className="skeleton" />
        ) : (
          <span className="lp muted">—</span>
        )}
      </div>

      <div className="pp-foot">
        {hardFail ? (
          <span className="pp-fail">
            {FAILURES[failure.code] || FAILURES.api_error}
          </span>
        ) : stale ? (
          <span className="pp-fail">
            stale — last ok {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
        ) : at ? (
          <>
            <span className={`live-dot ${phase === "polling" ? "on" : ""}`} />
            live · {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            {failure && <span className="pp-stale"> · retrying</span>}
          </>
        ) : busy ? (
          "fetching…"
        ) : (
          ""
        )}
      </div>
    </div>
  );
}
