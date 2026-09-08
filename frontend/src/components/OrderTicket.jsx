import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useGtts } from "../context/GttContext.jsx";

const PRODUCTS = ["CNC", "MIS", "NRML"];

/** Trigger sits this far below the live price by default. */
const TRIGGER_OFFSET = 0.1;

/** Default budget — quantity is derived from this and the price. */
const DEFAULT_INVESTMENT = 25000;

/** Fat-finger thresholds. */
const BIG_VALUE = 200_000; // ₹ — flag orders above this
const TRIGGER_FAR_PCT = 10; // trigger this far from LTP → flag
const LIMIT_OFF_PCT = 3; // limit this far from trigger → flag
const CONFIRM_WINDOW_MS = 5000;

const money = (n) =>
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const OFFSETS = [-2, -1, 0, 1, 2];

const ORDER_ERRORS = {
  no_token: "No Zerodha session — connect the broker before placing orders.",
  token_expired: "Session expired and re-login failed. Reconnect the broker.",
  invalid_symbol: "Zerodha doesn't recognise this symbol.",
  connection: "Zerodha didn't respond. Nothing was placed — try again.",
  offline: "Backend unreachable. Nothing was placed.",
};

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

const BLANK = {
  action: "BUY",
  quantity: "",
  trigger: "",
  limit: "",
  product: "CNC",
  investment: String(DEFAULT_INVESTMENT),
};

export default function OrderTicket({
  instrument,
  ltp,
  ltpStale,
  tokenReady,
  resetSignal,
  editing,
  onEditDone,
}) {
  const { refresh: refreshGtts } = useGtts();
  const [action, setAction] = useState(BLANK.action);
  const [quantity, setQuantity] = useState(BLANK.quantity);
  const [trigger, setTrigger] = useState(BLANK.trigger);
  const [limit, setLimit] = useState(BLANK.limit);
  const [product, setProduct] = useState(BLANK.product);
  const [investment, setInvestment] = useState(BLANK.investment);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const confirmTimer = useRef(null);

  const touched = useRef({ trigger: false, limit: false });
  /** Once the user types a quantity, stop deriving it from the budget. */
  const [qtyManual, setQtyManual] = useState(false);
  const prefilledFor = useRef(null);
  const [prefilled, setPrefilled] = useState(false);

  const isEdit = Boolean(editing);
  const key = instrument ? `${instrument.exchange}:${instrument.tradingsymbol}` : null;

  const clearConfirm = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setPendingConfirm(false);
  };

  const resetForm = () => {
    setAction(BLANK.action);
    setQuantity(BLANK.quantity);
    setTrigger(BLANK.trigger);
    setLimit(BLANK.limit);
    setProduct(BLANK.product);
    setInvestment(BLANK.investment);
    setQtyManual(false);
    setStatus(null);
    clearConfirm();
  };

  // "Clear all" from the desk bar
  useEffect(() => {
    if (resetSignal) resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // New instrument (and not entering edit mode) → fresh form
  useEffect(() => {
    touched.current = { trigger: false, limit: false };
    setQtyManual(false);
    prefilledFor.current = null;
    setPrefilled(false);
    setStatus(null);
    clearConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Entering / leaving edit mode → load the GTT's values, freeze prefill
  useEffect(() => {
    if (!editing) return;
    setAction(editing.action || "BUY");
    setQuantity(String(editing.quantity ?? ""));
    setTrigger(editing.trigger_price != null ? String(editing.trigger_price) : "");
    setLimit(editing.limit_price != null ? String(editing.limit_price) : "");
    setProduct(editing.product || "CNC");
    touched.current = { trigger: true, limit: true };
    setQtyManual(true); // the GTT's own quantity wins in edit mode
    prefilledFor.current = key;
    setPrefilled(false);
    setStatus(null);
    clearConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Prefill from LTP — create mode only
  useEffect(() => {
    if (isEdit || !key || !(ltp > 0) || prefilledFor.current === key) return;
    prefilledFor.current = key;
    const below = ltp - TRIGGER_OFFSET;
    if (!touched.current.limit) setLimit(ltp.toFixed(2));
    if (!touched.current.trigger) setTrigger((below > 0 ? below : ltp).toFixed(2));
    setPrefilled(true);
  }, [isEdit, key, ltp]);

  const editTrigger = (v) => {
    touched.current.trigger = true;
    setPrefilled(false);
    clearConfirm();
    setTrigger(v);
  };
  const editLimit = (v) => {
    touched.current.limit = true;
    setPrefilled(false);
    clearConfirm();
    setLimit(v);
  };

  const q = Number(quantity);
  const t = Number(trigger);
  const l = Number(limit);
  const budget = Number(investment);

  /** What a share actually costs for sizing: the limit if set, else the LTP. */
  const unitPrice = l > 0 ? l : ltp > 0 ? ltp : 0;

  // Budget drives quantity — until the user types a quantity of their own.
  useEffect(() => {
    if (isEdit || qtyManual) return;
    if (!(budget > 0) || !(unitPrice > 0)) return;
    const n = Math.floor(budget / unitPrice);
    setQuantity(n > 0 ? String(n) : "");
  }, [isEdit, qtyManual, budget, unitPrice]);

  const editQuantity = (v) => {
    setQtyManual(true); // manual quantity takes over
    clearConfirm();
    setQuantity(v);
  };
  const editInvestment = (v) => {
    setQtyManual(false); // budget is back in charge
    clearConfirm();
    setInvestment(v);
  };

  const deployed = q > 0 && unitPrice > 0 ? q * unitPrice : 0;
  const shortfall = budget > 0 && deployed > 0 ? budget - deployed : 0;

  const problems = useMemo(() => {
    const list = [];
    if (!instrument) list.push("Pick an instrument first");
    if (!Number.isInteger(q) || q <= 0) list.push("Set a quantity");
    if (!(t > 0)) list.push("Set a trigger price");
    if (!(l > 0)) list.push("Set a limit price");
    return list;
  }, [instrument, q, t, l]);

  const formOk = problems.length === 0;
  const estValue = formOk ? q * l : 0;

  // Fat-finger warnings — informational, not blocking
  const warnings = useMemo(() => {
    if (!formOk) return [];
    const w = [];
    if (estValue > BIG_VALUE) w.push(`Large order — ₹${money(estValue)}`);
    if (ltp > 0) {
      const trigPct = ((t - ltp) / ltp) * 100;
      if (Math.abs(trigPct) > TRIGGER_FAR_PCT)
        w.push(`Trigger is ${trigPct > 0 ? "+" : ""}${trigPct.toFixed(1)}% from LTP`);
    }
    const limPct = ((l - t) / t) * 100;
    if (Math.abs(limPct) > LIMIT_OFF_PCT)
      w.push(`Limit is ${limPct > 0 ? "+" : ""}${limPct.toFixed(1)}% off the trigger`);
    return w;
  }, [formOk, estValue, ltp, t, l]);

  const canSubmit = formOk && tokenReady && !(ltpStale && !isEdit);
  const blockReason = !formOk
    ? problems[0]
    : !tokenReady
      ? "Broker not connected"
      : ltpStale && !isEdit
        ? "Live price is stale — refresh it before arming"
        : null;

  const bump = (setter, cur, delta) => () => {
    const next = Math.max(0, (Number(cur) || 0) + delta);
    setter(Number.isInteger(delta) ? String(Math.round(next)) : next.toFixed(2));
  };

  const run = async () => {
    clearConfirm();
    const payload = {
      symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
      action,
      quantity: q,
      trigger_price: t,
      price: l,
      product,
    };
    setBusy(true);
    setStatus({ type: "info", msg: isEdit ? "Updating GTT…" : "Placing GTT…" });
    try {
      if (isEdit) {
        await api.updateGtt(editing.id, payload);
        setStatus({ type: "ok", msg: `GTT #${editing.id} updated.` });
        onEditDone?.();
      } else {
        const res = await api.createGtt(payload);
        const id = res?.gtt?.trigger_id;
        setStatus({ type: "ok", msg: `GTT armed${id ? ` · #${id}` : ""}.` });
      }
      refreshGtts?.();
    } catch (err) {
      setStatus({ type: "err", msg: ORDER_ERRORS[err.code] || err.message });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) {
      setStatus({ type: "err", msg: blockReason });
      return;
    }
    if (!pendingConfirm) {
      setPendingConfirm(true);
      setStatus(null);
      confirmTimer.current = setTimeout(() => setPendingConfirm(false), CONFIRM_WINDOW_MS);
      return;
    }
    run();
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
              Investment
              {!qtyManual && deployed > 0 && (
                <span className="delta">₹{money(shortfall)} left</span>
              )}
            </label>
            <div className="stepper">
              <button type="button" onClick={bump(editInvestment, investment, -1000)}>
                −
              </button>
              <input
                inputMode="numeric"
                value={investment}
                onChange={(e) => editInvestment(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="25000"
              />
              <button type="button" onClick={bump(editInvestment, investment, 1000)}>
                +
              </button>
            </div>
            <div className="quick">
              {[10000, 25000, 50000, 100000].map((v) => (
                <button
                  type="button"
                  key={v}
                  onClick={() => editInvestment(String(v))}
                  title={`Set budget to ₹${v.toLocaleString("en-IN")}`}
                >
                  {v >= 100000 ? `${v / 100000}L` : `${v / 1000}k`}
                </button>
              ))}
            </div>
          </div>

          <div className="f">
            <label>
              Quantity
              {qtyManual ? (
                <span className="delta">manual</span>
              ) : unitPrice > 0 ? (
                <span className="delta">₹{money(unitPrice)} each</span>
              ) : null}
            </label>
            <div className="stepper">
              <button type="button" onClick={bump(editQuantity, quantity, -1)}>
                −
              </button>
              <input
                inputMode="numeric"
                value={quantity}
                onChange={(e) => editQuantity(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="0"
              />
              <button type="button" onClick={bump(editQuantity, quantity, 1)}>
                +
              </button>
            </div>
            {qtyManual && budget > 0 && unitPrice > 0 && (
              <div className="quick">
                <button
                  type="button"
                  className="wide"
                  onClick={() => setQtyManual(false)}
                >
                  ↺ back to ₹{money(budget)} budget
                </button>
              </div>
            )}
          </div>

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
