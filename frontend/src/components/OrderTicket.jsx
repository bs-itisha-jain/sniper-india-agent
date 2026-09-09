import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useGtts } from "../context/GttContext.jsx";

const PRODUCTS = ["CNC", "MIS", "NRML"];

/** SL and target sit this far either side of the limit price by default. */
const SL_PCT = 0.8;

/** Default budget — quantity is derived from this and the price. */
const DEFAULT_INVESTMENT = 25000;

/** Fat-finger thresholds. */
const BIG_VALUE = 200_000; // ₹ — flag positions above this
const CONFIRM_WINDOW_MS = 5000;

const money = (n) =>
  Number(n || 0).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const OFFSETS = [-2, -1, 0, 1, 2];

const ORDER_ERRORS = {
  no_token: "No Zerodha session — connect the broker before placing orders.",
  token_expired: "Session expired. Reconnect the broker.",
  invalid_symbol: "Zerodha doesn't recognise this symbol.",
  connection: "Zerodha didn't respond. Nothing was placed — try again.",
  offline: "Backend unreachable. Nothing was placed.",
};

/** SL / target for a given entry price and the position being taken. */
function legsFor(base, action) {
  const off = base * (SL_PCT / 100);
  return action === "BUY"
    ? { sl: base - off, target: base + off } // long: SL below, target above
    : { sl: base + off, target: base - off }; // short: SL above, target below
}

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

function Delta({ value, base, label }) {
  const v = Number(value);
  const b = Number(base);
  if (!(b > 0) || !(v > 0)) return <span className="delta">{label}</span>;
  const pct = ((v - b) / b) * 100;
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
  sl: "",
  target: "",
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
  const [sl, setSl] = useState(BLANK.sl);
  const [target, setTarget] = useState(BLANK.target);
  const [product, setProduct] = useState(BLANK.product);
  const [investment, setInvestment] = useState(BLANK.investment);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const confirmTimer = useRef(null);

  const touched = useRef({ trigger: false, limit: false, sl: false, target: false });
  /** Once the user types a quantity, stop deriving it from the budget. */
  const [qtyManual, setQtyManual] = useState(false);
  const prefilledFor = useRef(null);
  const [prefilled, setPrefilled] = useState(false);

  const isEdit = Boolean(editing);
  const editKind = editing?.kind || null; // "entry" | "exit"
  const wantsEntry = !isEdit || editKind === "entry";
  const wantsExit = !isEdit || editKind === "exit";
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
    setSl(BLANK.sl);
    setTarget(BLANK.target);
    setProduct(BLANK.product);
    setInvestment(BLANK.investment);
    setQtyManual(false);
    setStatus(null);
    touched.current = { trigger: false, limit: false, sl: false, target: false };
    clearConfirm();
  };

  // "Clear all" from the desk bar
  useEffect(() => {
    if (resetSignal) resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // New instrument (and not entering edit mode) → fresh form
  useEffect(() => {
    touched.current = { trigger: false, limit: false, sl: false, target: false };
    setQtyManual(false);
    prefilledFor.current = null;
    setPrefilled(false);
    setStatus(null);
    clearConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Entering edit mode → load the GTT's values, freeze prefill
  useEffect(() => {
    if (!editing) return;
    setAction(editing.action || "BUY");
    setQuantity(String(editing.quantity ?? ""));
    setTrigger(editing.trigger_price != null ? String(editing.trigger_price) : "");
    setLimit(editing.limit_price != null ? String(editing.limit_price) : "");
    setSl(editing.sl_price != null ? String(editing.sl_price) : "");
    setTarget(editing.target_price != null ? String(editing.target_price) : "");
    setProduct(editing.product || "CNC");
    touched.current = { trigger: true, limit: true, sl: true, target: true };
    setQtyManual(true); // the GTT's own quantity wins in edit mode
    prefilledFor.current = key;
    setPrefilled(false);
    setStatus(null);
    clearConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Prefill trigger + limit from LTP — create mode only
  useEffect(() => {
    if (isEdit || !key || !(ltp > 0) || prefilledFor.current === key) return;
    prefilledFor.current = key;
    const px = ltp.toFixed(2);
    if (!touched.current.limit) setLimit(px);
    if (!touched.current.trigger) setTrigger(px);
    setPrefilled(true);
  }, [isEdit, key, ltp]);

  // Auto-derive SL + target at ±0.8% from the limit price, per side.
  useEffect(() => {
    if (isEdit) return;
    const base = Number(limit);
    if (!(base > 0)) return;
    const { sl: dSl, target: dTarget } = legsFor(base, action);
    if (!touched.current.sl) setSl(dSl.toFixed(2));
    if (!touched.current.target) setTarget(dTarget.toFixed(2));
  }, [isEdit, limit, action]);

  const setSide = (a) => {
    setAction(a);
    // side change flips which way SL/target point — re-derive them
    touched.current.sl = false;
    touched.current.target = false;
    clearConfirm();
  };

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
  const editSl = (v) => {
    touched.current.sl = true;
    setPrefilled(false);
    clearConfirm();
    setSl(v);
  };
  const editTarget = (v) => {
    touched.current.target = true;
    setPrefilled(false);
    clearConfirm();
    setTarget(v);
  };
  const resetLegs = () => {
    touched.current.sl = false;
    touched.current.target = false;
    const base = Number(limit);
    if (base > 0) {
      const { sl: dSl, target: dTarget } = legsFor(base, action);
      setSl(dSl.toFixed(2));
      setTarget(dTarget.toFixed(2));
    }
    clearConfirm();
  };

  const q = Number(quantity);
  const tr = Number(trigger);
  const l = Number(limit);
  const s = Number(sl);
  const tg = Number(target);
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
    setQtyManual(true);
    clearConfirm();
    setQuantity(v);
  };
  const editInvestment = (v) => {
    setQtyManual(false);
    clearConfirm();
    setInvestment(v);
  };

  const deployed = q > 0 && unitPrice > 0 ? q * unitPrice : 0;
  const shortfall = budget > 0 && deployed > 0 ? budget - deployed : 0;

  const problems = useMemo(() => {
    const list = [];
    if (!instrument) list.push("Pick an instrument first");
    if (!Number.isInteger(q) || q <= 0) list.push("Set a quantity");
    if (!(l > 0)) list.push("Set a limit price");
    if (wantsEntry && !(tr > 0)) list.push("Set a trigger price");
    if (wantsExit && !(s > 0)) list.push("Set a stop-loss");
    if (wantsExit && !(tg > 0)) list.push("Set a target");

    if (wantsEntry && tr > 0 && l > 0) {
      if (action === "BUY" && tr > l) list.push("BUY: trigger can't be above the limit");
      if (action === "SELL" && tr < l) list.push("SELL: trigger can't be below the limit");
    }
    if (wantsExit && l > 0 && s > 0 && tg > 0) {
      if (action === "BUY" && !(s < l && tg > l))
        list.push("BUY: stop-loss below the limit, target above");
      if (action === "SELL" && !(s > l && tg < l))
        list.push("SELL: stop-loss above the limit, target below");
    }
    // Zerodha needs the OCO's two triggers to straddle the live price.
    if (wantsExit && !isEdit && ltp > 0 && s > 0 && tg > 0) {
      const lo = Math.min(s, tg);
      const hi = Math.max(s, tg);
      if (!(lo < ltp && ltp < hi))
        list.push("SL and target must straddle the live price");
    }
    return list;
  }, [instrument, q, l, tr, s, tg, action, wantsEntry, wantsExit, isEdit, ltp]);

  const formOk = problems.length === 0;

  const riskValue = formOk && wantsExit ? Math.abs(l - s) * q : 0;
  const rewardValue = formOk && wantsExit ? Math.abs(tg - l) * q : 0;
  const estValue = formOk ? q * l : 0;

  const warnings = useMemo(() => {
    if (!formOk) return [];
    const w = [];
    if (estValue > BIG_VALUE) w.push(`Large position — ₹${money(estValue)}`);
    if (wantsExit && l > 0 && s > 0 && tg > 0) {
      const slPct = Math.abs((l - s) / l) * 100;
      const tgPct = Math.abs((tg - l) / l) * 100;
      if (slPct > 3) w.push(`Stop-loss is ${slPct.toFixed(1)}% away`);
      if (tgPct > 3) w.push(`Target is ${tgPct.toFixed(1)}% away`);
    }
    return w;
  }, [formOk, estValue, l, s, tg, wantsExit]);

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
      trigger_price: tr || l,
      limit_price: l,
      sl_price: s || (action === "BUY" ? l * 0.99 : l * 1.01),
      target_price: tg || (action === "BUY" ? l * 1.01 : l * 0.99),
      product,
    };
    setBusy(true);
    setStatus({ type: "info", msg: isEdit ? "Updating GTT…" : "Placing GTTs…" });
    try {
      if (isEdit) {
        await api.updateGtt(editing.id, { ...payload, kind: editKind });
        setStatus({ type: "ok", msg: `GTT #${editing.id} updated.` });
        onEditDone?.();
      } else {
        const res = await api.createGtt(payload);
        if (res?.exit_error) {
          setStatus({
            type: "err",
            msg: `Entry GTT placed, but SL/target failed: ${res.exit_error}`,
          });
        } else {
          setStatus({ type: "ok", msg: "Entry + SL/target GTTs armed." });
        }
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
  const legsCustom = touched.current.sl || touched.current.target;

  return (
    <form className={`ticket ${sideClass}`} onSubmit={submit}>
      <div className="tk-fields">
        {isEdit && (
          <div className="edit-banner">
            Modifying {editKind === "exit" ? "SL/target" : "entry"} GTT #{editing.id}
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
            onClick={() => setSide("BUY")}
          >
            BUY
          </button>
          <button
            type="button"
            className={action === "SELL" ? "on" : ""}
            onClick={() => setSide("SELL")}
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
                <button type="button" className="wide" onClick={() => setQtyManual(false)}>
                  ↺ ₹{money(budget)} budget
                </button>
              </div>
            )}
          </div>

          {wantsEntry && (
            <div className="f">
              <label>
                Trigger price <Delta value={trigger} base={ltp} label="Δ LTP" />
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
            </div>
          )}

          <div className="f">
            <label>
              Limit price <Delta value={limit} base={ltp} label="Δ LTP" />
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
          </div>

          {wantsExit && (
            <>
              <div className="f">
                <label>
                  Stop-loss <Delta value={sl} base={limit} label={`−${SL_PCT}%`} />
                </label>
                <div className="stepper">
                  <button type="button" onClick={bump(editSl, sl, -0.05)}>
                    −
                  </button>
                  <input
                    inputMode="decimal"
                    value={sl}
                    onChange={(e) => editSl(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="0.00"
                  />
                  <button type="button" onClick={bump(editSl, sl, 0.05)}>
                    +
                  </button>
                </div>
              </div>

              <div className="f">
                <label>
                  Target <Delta value={target} base={limit} label={`+${SL_PCT}%`} />
                </label>
                <div className="stepper">
                  <button type="button" onClick={bump(editTarget, target, -0.05)}>
                    −
                  </button>
                  <input
                    inputMode="decimal"
                    value={target}
                    onChange={(e) => editTarget(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="0.00"
                  />
                  <button type="button" onClick={bump(editTarget, target, 0.05)}>
                    +
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {wantsExit && legsCustom && !isEdit && l > 0 && (
          <div className="quick">
            <button type="button" className="wide" onClick={resetLegs}>
              ↺ back to ±{SL_PCT}% SL / target
            </button>
          </div>
        )}

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
            Prefilled — trigger &amp; limit ₹{money(l)}, SL &amp; target at ±{SL_PCT}%. Edit
            any field to take over.
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
            <span>{action} {q > 0 ? q : ""}</span>
            <b>
              {wantsEntry
                ? tr > 0
                  ? `LTP ${action === "BUY" ? "≤" : "≥"} ₹${money(tr)} → ₹${money(l)}`
                  : "trigger not set"
                : `₹${money(l)}`}
            </b>
          </div>
          {wantsExit && (
            <>
              <div className="receipt-row">
                <span>Stop-loss</span>
                <b>{s > 0 ? `₹${money(s)}` : "—"}</b>
              </div>
              <div className="receipt-row">
                <span>Target</span>
                <b>{tg > 0 ? `₹${money(tg)}` : "—"}</b>
              </div>
              <div className="receipt-row">
                <span>Risk / reward</span>
                <b>
                  {riskValue > 0 ? `−₹${money(riskValue)}` : "—"} /{" "}
                  {rewardValue > 0 ? `+₹${money(rewardValue)}` : "—"}
                </b>
              </div>
            </>
          )}
          <div className="receipt-row">
            <span>Product</span>
            <b>{product}</b>
          </div>
          <div className="receipt-row total">
            <span>Position value</span>
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
            {blockReason ||
              (isEdit
                ? "Updates this GTT"
                : "Places an entry GTT + a linked SL/target OCO GTT")}
          </div>
        )}
      </aside>
    </form>
  );
}
