import { useEffect, useState } from "react";
import { useStrategy } from "../context/StrategyContext.jsx";
import { SL_PCT, phase1SlQty, reversedQty } from "../lib/strategy.js";

const money = (n) =>
  Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const PHASE_LABEL = {
  awaiting_entry: "Waiting for entry to fill…",
  phase1: "Phase 1 live — target / SL armed",
  phase2: "Phase 2 live — reversed position, target / SL armed",
  done_win: "Done — target hit, profit",
  done_loss: "Done — Phase 2 SL hit. Loss taken, stopped.",
  error: "Error — needs attention",
};
const PHASE_TONE = {
  awaiting_entry: "st-auth",
  phase1: "st-ok",
  phase2: "st-warn",
  done_win: "st-ok",
  done_loss: "st-down",
  error: "st-down",
};

export default function StrategyPanel({ instrument, ltp }) {
  const ctx = useStrategy();

  const [side, setSide] = useState("BUY");
  const [qty, setQty] = useState("25");
  const [trigger, setTrigger] = useState("");
  const [limit, setLimit] = useState("");
  const [product, setProduct] = useState("MIS");
  const [err, setErr] = useState("");

  const strat = ctx?.strat;

  // prefill trigger / limit from the live price
  useEffect(() => {
    if (!(ltp > 0) || strat) return;
    setLimit(ltp.toFixed(2));
    setTrigger((side === "BUY" ? ltp - 0.1 : ltp + 0.1).toFixed(2));
  }, [ltp, side, strat]);

  if (!ctx) return null; // provider not mounted yet (HMR)
  const { busy, start, stop, clear } = ctx;

  if (strat) {
    const done = ["done_win", "done_loss", "error"].includes(strat.state);
    return (
      <div className="strat-panel">
        <div className="strat-head">
          <span className="eyebrow">Strategy</span>
          <span className={`broker-pill ${PHASE_TONE[strat.state] || ""}`}>
            <span className="dot" />
            {strat.tradingsymbol}
          </span>
        </div>

        <div className={`notice ${done ? (strat.state === "done_win" ? "ok" : "err") : "info"} tiny`}>
          {PHASE_LABEL[strat.state] || strat.state}
        </div>

        <div className="strat-facts">
          <div><span>Entry</span><b>{strat.side} {strat.qty}{strat.entryPrice ? ` @ ₹${money(strat.entryPrice)}` : ""}</b></div>
          {strat.phase1 && (
            <div><span>Phase 1</span><b>T ₹{money(strat.phase1.legs.target_trigger)} · SL ₹{money(strat.phase1.legs.sl_trigger)} ({strat.phase1.slQty})</b></div>
          )}
          {strat.reversedSide && (
            <div><span>Reversed</span><b>{strat.reversedSide} {strat.reversedQty} @ ₹{money(strat.reversePrice)}</b></div>
          )}
          {strat.phase2 && (
            <div><span>Phase 2</span><b>T ₹{money(strat.phase2.legs.target_trigger)} · SL ₹{money(strat.phase2.legs.sl_trigger)}</b></div>
          )}
        </div>

        <div className="strat-log">
          {(strat.events || []).slice(-4).reverse().map((e, i) => (
            <div key={i}>{e.text}</div>
          ))}
        </div>

        {done ? (
          <button className="btn ghost sm" onClick={clear} type="button">
            Clear
          </button>
        ) : (
          <button className="btn ghost sm danger" onClick={stop} disabled={busy} type="button">
            {busy ? "…" : "Stop & cancel GTTs"}
          </button>
        )}
        <div className="hint-line">Keep this tab open — it advances by polling every 8s.</div>
      </div>
    );
  }

  // --- start form ---
  const q = Number(qty);
  const t = Number(trigger);
  const l = Number(limit);
  const ready = instrument && Number.isInteger(q) && q > 0 && t > 0 && l > 0;
  const slQ = q > 0 ? phase1SlQty(q) : 0;
  const revQ = q > 0 ? reversedQty(q) : 0;

  const go = async () => {
    setErr("");
    const r = await start({
      symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
      tradingsymbol: instrument.tradingsymbol,
      exchange: instrument.exchange,
      side,
      qty: q,
      triggerPrice: t,
      limitPrice: l,
      product,
    });
    if (!r.ok) setErr(r.error);
  };

  return (
    <div className="strat-panel">
      <div className="strat-head">
        <span className="eyebrow">Strategy</span>
        <span className="hint-line" style={{ margin: 0 }}>2-phase reversal · ±{SL_PCT}%</span>
      </div>

      {!instrument ? (
        <div className="feed-empty">Pick a symbol first.</div>
      ) : (
        <>
          <div className="side sm">
            <button type="button" className={side === "BUY" ? "on" : ""} onClick={() => setSide("BUY")}>BUY</button>
            <button type="button" className={side === "SELL" ? "on" : ""} onClick={() => setSide("SELL")}>SELL</button>
          </div>

          <div className="grid2 tight">
            <label className="f">Qty (Q)
              <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))} />
            </label>
            <label className="f">Product
              <select value={product} onChange={(e) => setProduct(e.target.value)}>
                <option>MIS</option>
                <option>CNC</option>
              </select>
            </label>
            <label className="f">Trigger
              <input inputMode="decimal" value={trigger} onChange={(e) => setTrigger(e.target.value.replace(/[^\d.]/g, ""))} />
            </label>
            <label className="f">Limit
              <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} />
            </label>
          </div>

          {q > 0 && (
            <div className="hint-line" style={{ margin: "2px 0 0" }}>
              Phase 1 SL leg = {slQ} · reverses to {revQ} the other way
            </div>
          )}

          {err && <div className="notice err tiny">{err}</div>}

          <button className={`btn fire ${side === "SELL" ? "sell" : ""}`} onClick={go} disabled={!ready || busy} type="button">
            {busy ? <span className="spin" /> : `Start — ${side} ${q || ""} ${instrument.tradingsymbol}`}
          </button>
          {product === "CNC" && (
            <div className="hint-line">CNC can't go net short — the Phase 1 SL reversal needs MIS.</div>
          )}
        </>
      )}
    </div>
  );
}
