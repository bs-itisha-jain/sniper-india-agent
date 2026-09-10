import { useOrderForm, money } from "../context/OrderFormContext.jsx";
import SizePanel from "./SizePanel.jsx";

const PRODUCTS = ["CNC", "MIS"];
const OFFSETS = [-2, -1, 0, 1, 2];

function Quick({ ltp, onPick }) {
  if (!ltp) return null;
  return (
    <div className="quick">
      {OFFSETS.map((p) => (
        <button
          type="button"
          key={p}
          title={`Set to LTP ${p === 0 ? "" : `${p > 0 ? "+" : ""}${p}%`}`}
          onClick={() => onPick((ltp * (1 + p / 100)).toFixed(2))}
        >
          {p === 0 ? "LTP" : `${p > 0 ? "+" : ""}${p}%`}
        </button>
      ))}
    </div>
  );
}

function Delta({ value, ltp }) {
  const v = Number(value);
  if (!ltp || !(v > 0)) return <span className="delta">Δ LTP</span>;
  const pct = ((v - ltp) / ltp) * 100;
  const cls = pct > 0 ? "pos" : pct < 0 ? "neg" : "";
  return (
    <span className={`delta ${cls}`}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(2)}%
    </span>
  );
}

export default function OrderTicket() {
  const {
    instrument,
    ltp,
    isEdit,
    editing,
    onEditDone,
    action,
    setAction,
    trigger,
    editTrigger,
    limit,
    editLimit,
    product,
    setProduct,
    clearConfirm,
    q,
    t,
    l,
    estValue,
    prefilled,
    TRIGGER_OFFSET,
    submit,
    busy,
    status,
    canSubmit,
    blockReason,
    warnings,
    pendingConfirm,
  } = useOrderForm();

  const bump = (setter, cur, delta) => () => {
    const next = Math.max(0, (Number(cur) || 0) + delta);
    setter(next.toFixed(2));
  };

  const sideClass = action === "SELL" ? "sell" : "";
  const verb = isEdit ? "Update" : "Arm";

  return (
    <form className={`ticket ${sideClass}`} onSubmit={submit}>
      <div className="tk-fields">
        {isEdit && (
          <div className="edit-banner">
            Modifying GTT #{editing.id}
            <button type="button" onClick={onEditDone}>
              cancel
            </button>
          </div>
        )}

        <div className={`side ${action === "SELL" ? "is-sell" : ""}`}>
          <span className="side-thumb" />
          <button
            type="button"
            className={action === "BUY" ? "on" : ""}
            onClick={() => {
              setAction("BUY");
              clearConfirm();
            }}
          >
            BUY
          </button>
          <button
            type="button"
            className={action === "SELL" ? "on" : ""}
            onClick={() => {
              setAction("SELL");
              clearConfirm();
            }}
          >
            SELL
          </button>
        </div>

        <div className="grid2">
          <div className="f">
            <label>
              Trigger price <Delta value={trigger} ltp={ltp} />
            </label>
            <div className="stepper">
              <button type="button" onClick={bump(editTrigger, trigger, -0.05)}>
                −
              </button>
              <input
                inputMode="decimal"
                value={trigger}
                onChange={(e) => editTrigger(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
              />
              <button type="button" onClick={bump(editTrigger, trigger, 0.05)}>
                +
              </button>
            </div>
            <Quick ltp={ltp} onPick={editTrigger} />
          </div>

          <div className="f">
            <label>
              Limit price <Delta value={limit} ltp={ltp} />
            </label>
            <div className="stepper">
              <button type="button" onClick={bump(editLimit, limit, -0.05)}>
                −
              </button>
              <input
                inputMode="decimal"
                value={limit}
                onChange={(e) => editLimit(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
              />
              <button type="button" onClick={bump(editLimit, limit, 0.05)}>
                +
              </button>
            </div>
            <Quick ltp={ltp} onPick={editLimit} />
          </div>
        </div>

        <div className="f f-wide">
          <label>Product</label>
          <div className="pills">
            {PRODUCTS.map((p) => (
              <button
                type="button"
                key={p}
                className={product === p ? "on" : ""}
                onClick={() => {
                  setProduct(p);
                  clearConfirm();
                }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {prefilled && ltp > 0 && !isEdit && (
          <div className="prefill-note">
            Prefilled from LTP — limit ₹{money(ltp)}, trigger ₹{TRIGGER_OFFSET.toFixed(2)}{" "}
            below. Edit either to take over.
          </div>
        )}
      </div>

      <aside className="tk-summary">
        <SizePanel />

        <div className="receipt">
          <div className="receipt-row">
            <span>Instrument</span>
            <b>{instrument ? instrument.tradingsymbol : "—"}</b>
          </div>
          <div className="receipt-row">
            <span>When</span>
            <b>
              {t > 0
                ? `LTP ${action === "BUY" ? "≤" : "≥"} ₹${money(t)}`
                : "trigger not set"}
            </b>
          </div>
          <div className="receipt-row">
            <span>Then place</span>
            <b>
              {action} {q > 0 ? q : "—"} @ ₹{l > 0 ? money(l) : "—"}
            </b>
          </div>
          <div className="receipt-row">
            <span>Product</span>
            <b>{product}</b>
          </div>
          <div className="receipt-row total">
            <span>Est. order value</span>
            <b>{estValue > 0 ? `₹${money(estValue)}` : "—"}</b>
          </div>
        </div>

        {pendingConfirm && warnings.length > 0 && (
          <ul className="warn-list">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        {status && <div className={`notice ${status.type} tiny`}>{status.msg}</div>}

        <button
          type="submit"
          className={`btn fire ${sideClass} ${pendingConfirm ? "confirm" : ""}`}
          disabled={busy || !canSubmit}
        >
          {busy ? (
            <span className="spin" />
          ) : pendingConfirm ? (
            `Confirm — ${verb.toLowerCase()} ${action} ${q} ${instrument?.tradingsymbol || ""}`
          ) : (
            `${verb} ${action}${instrument ? ` · ${instrument.tradingsymbol}` : " GTT"}`
          )}
        </button>

        {pendingConfirm ? (
          <button className="hint-line as-link" type="button" onClick={clearConfirm}>
            not now
          </button>
        ) : (
          <div className="hint-line">
            {blockReason || "GTT fires the LIMIT order when the trigger is met"}
          </div>
        )}
      </aside>
    </form>
  );
}
