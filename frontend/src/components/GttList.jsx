import { useState } from "react";
import { useGtts } from "../context/GttContext.jsx";
import { useBroker } from "../context/BrokerContext.jsx";

const money = (n) =>
  n == null
    ? "—"
    : Number(n).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const STATUS_TONE = {
  active: "ok",
  triggered: "info",
  disabled: "muted",
  expired: "muted",
  cancelled: "muted",
  rejected: "bad",
  deleted: "muted",
};

function GttRow({ g, onEdit }) {
  const { cancel } = useGtts();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const doCancel = async () => {
    setBusy(true);
    setErr("");
    const r = await cancel(g.id);
    if (!r.ok) {
      setErr(r.error);
      setBusy(false);
      setConfirming(false);
    }
  };

  const tone = STATUS_TONE[g.status] || "muted";
  const canManage = g.status === "active";

  return (
    <div className="gtt-row">
      <div className="gtt-main">
        <span className={`tag ${g.action === "BUY" ? "buy" : "sell"}`}>{g.action}</span>
        <span className="gtt-sym">{g.tradingsymbol}</span>
        <span className={`gtt-status s-${tone}`}>{g.status}</span>
      </div>
      <div className="gtt-detail">
        {g.quantity} qty · trigger ₹{money(g.trigger_price)} → limit ₹{money(g.limit_price)} ·{" "}
        {g.product}
      </div>

      {canManage && (
        <div className="gtt-actions">
          {confirming ? (
            <>
              <button className="gx danger" onClick={doCancel} disabled={busy} type="button">
                {busy ? "…" : "Confirm cancel"}
              </button>
              <button className="gx" onClick={() => setConfirming(false)} type="button">
                keep
              </button>
            </>
          ) : (
            <>
              <button className="gx" onClick={() => onEdit(g)} type="button">
                Modify
              </button>
              <button className="gx" onClick={() => setConfirming(true)} type="button">
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {err && <div className="gtt-err">{err}</div>}
    </div>
  );
}

export default function GttList({ onEdit }) {
  const broker = useBroker();
  const gtt = useGtts();
  if (!broker || !gtt) return null; // providers not mounted yet (HMR)

  const { ready } = broker;
  const { gtts, loading, error, loadedOnce, refresh } = gtt;

  const active = gtts.filter((g) => g.status === "active");
  const past = gtts.filter((g) => g.status !== "active");

  return (
    <div className="feed">
      <div className="feed-head">
        <span className="eyebrow">Live GTTs</span>
        <button
          className="feed-refresh"
          onClick={refresh}
          disabled={loading || !ready}
          type="button"
          title="Refresh"
        >
          {loading ? <span className="spin" /> : "↻"}
        </button>
      </div>

      <div className="feed-scroll">
        {!ready ? (
          <div className="feed-empty">Connect the broker to see your GTTs.</div>
        ) : error && !loadedOnce ? (
          <div className="feed-empty err-note">{error}</div>
        ) : !loadedOnce && loading ? (
          <div className="feed-empty">Loading…</div>
        ) : gtts.length === 0 ? (
          <div className="feed-empty">No GTTs at Zerodha yet.</div>
        ) : (
          <div className="gtt-list">
            {active.map((g) => (
              <GttRow key={g.id} g={g} onEdit={onEdit} />
            ))}
            {past.length > 0 && (
              <div className="gtt-past-label">
                {past.length} inactive
              </div>
            )}
            {past.map((g) => (
              <GttRow key={g.id} g={g} onEdit={onEdit} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
