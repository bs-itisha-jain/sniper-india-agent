import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api/client.js";
import { useGtts } from "./GttContext.jsx";

const OrderFormCtx = createContext(null);

/** Trigger sits this % from the live price by default (Zerodha needs ≥ 0.25%). */
const TRIGGER_PCT = 0.3;
/** Zerodha rejects a GTT whose trigger is closer than this to the LTP. */
const MIN_TRIGGER_PCT = 0.25;
/**
 * "Market" mode: the fired LIMIT order is priced this % past the LTP on the
 * fill side (above for a BUY, below for a SELL) so it sweeps the book and
 * fills straight away — a market order in all but name.
 */
const MARKET_LIMIT_PCT = 0.3;
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

const ORDER_ERRORS = {
  no_token: "No Zerodha session — connect the broker before placing orders.",
  token_expired: "Session expired and re-login failed. Reconnect the broker.",
  invalid_symbol: "Zerodha doesn't recognise this symbol.",
  connection: "Zerodha didn't respond. Nothing was placed — try again.",
  offline: "Backend unreachable. Nothing was placed.",
};

const BLANK = {
  action: "BUY",
  quantity: "",
  trigger: "",
  limit: "",
  product: "CNC",
  investment: String(DEFAULT_INVESTMENT),
  priceMode: "limit", // "limit" | "market"
};

/** The market-mode limit: LTP nudged past itself on the side the order fills. */
const marketLimit = (ltp, action) => {
  const off = MARKET_LIMIT_PCT / 100;
  return (action === "BUY" ? ltp * (1 + off) : ltp * (1 - off)).toFixed(2);
};

export function OrderFormProvider({
  instrument,
  ltp,
  ltpStale,
  tokenReady,
  editing,
  onEditDone,
  resetSignal,
  children,
}) {
  const { refresh: refreshGtts } = useGtts();

  const [action, setAction] = useState(BLANK.action);
  const [quantity, setQuantity] = useState(BLANK.quantity);
  const [trigger, setTrigger] = useState(BLANK.trigger);
  const [limit, setLimit] = useState(BLANK.limit);
  const [product, setProduct] = useState(BLANK.product);
  const [priceMode, setPriceModeRaw] = useState(BLANK.priceMode);
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

  const clearConfirm = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setPendingConfirm(false);
  }, []);

  const resetForm = useCallback(() => {
    setAction(BLANK.action);
    setQuantity(BLANK.quantity);
    setTrigger(BLANK.trigger);
    setLimit(BLANK.limit);
    setProduct(BLANK.product);
    setPriceModeRaw(BLANK.priceMode);
    setInvestment(BLANK.investment);
    setQtyManual(false);
    setStatus(null);
    clearConfirm();
  }, [clearConfirm]);

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
    setPriceModeRaw("limit"); // an existing GTT is edited as a plain limit
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
    const off = TRIGGER_PCT / 100;
    const trig = action === "BUY" ? ltp * (1 - off) : ltp * (1 + off);
    if (!touched.current.trigger) setTrigger((trig > 0 ? trig : ltp).toFixed(2));
    if (!touched.current.limit) {
      setLimit(priceMode === "market" ? marketLimit(ltp, action) : ltp.toFixed(2));
    }
    setPrefilled(true);
  }, [isEdit, key, ltp, action, priceMode]);

  // Market mode owns the limit price — keep it pinned past the LTP.
  useEffect(() => {
    if (isEdit || priceMode !== "market" || !(ltp > 0)) return;
    setLimit(marketLimit(ltp, action));
  }, [isEdit, priceMode, ltp, action]);

  /** Switching to market snaps the limit immediately; back to limit leaves it. */
  const setPriceMode = useCallback(
    (mode) => {
      setPriceModeRaw(mode);
      clearConfirm();
      if (mode === "market" && ltp > 0) {
        touched.current.limit = false;
        setLimit(marketLimit(ltp, action));
      }
    },
    [ltp, action, clearConfirm]
  );

  const editTrigger = useCallback(
    (v) => {
      touched.current.trigger = true;
      setPrefilled(false);
      clearConfirm();
      setTrigger(v);
    },
    [clearConfirm]
  );
  const editLimit = useCallback(
    (v) => {
      if (priceMode === "market") return; // market mode computes the limit
      touched.current.limit = true;
      setPrefilled(false);
      clearConfirm();
      setLimit(v);
    },
    [clearConfirm, priceMode]
  );

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

  const editQuantity = useCallback(
    (v) => {
      setQtyManual(true); // manual quantity takes over
      clearConfirm();
      setQuantity(v);
    },
    [clearConfirm]
  );
  const editInvestment = useCallback(
    (v) => {
      setQtyManual(false); // budget is back in charge
      clearConfirm();
      setInvestment(v);
    },
    [clearConfirm]
  );

  const deployed = q > 0 && unitPrice > 0 ? q * unitPrice : 0;
  const shortfall = budget > 0 && deployed > 0 ? budget - deployed : 0;

  const problems = useMemo(() => {
    const list = [];
    if (!instrument) list.push("Pick an instrument first");
    if (!Number.isInteger(q) || q <= 0) list.push("Set a quantity");
    if (!(t > 0)) list.push("Set a trigger price");
    if (!(l > 0)) list.push("Set a limit price");
    if (ltp > 0 && t > 0 && (Math.abs(t - ltp) / ltp) * 100 < MIN_TRIGGER_PCT)
      list.push(`Trigger must be ≥ ${MIN_TRIGGER_PCT}% from the last price (Zerodha rule)`);
    return list;
  }, [instrument, q, t, l, ltp]);

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

  const value = {
    // instrument context
    instrument,
    ltp,
    isEdit,
    editing,
    onEditDone,
    // field state + setters
    action,
    setAction,
    trigger,
    editTrigger,
    limit,
    editLimit,
    product,
    setProduct,
    priceMode,
    setPriceMode,
    investment,
    editInvestment,
    quantity,
    editQuantity,
    qtyManual,
    setQtyManual,
    clearConfirm,
    // derived numbers
    q,
    t,
    l,
    budget,
    unitPrice,
    deployed,
    shortfall,
    estValue,
    prefilled,
    TRIGGER_PCT,
    MARKET_LIMIT_PCT,
    MIN_TRIGGER_PCT,
    // submit flow
    submit,
    busy,
    status,
    canSubmit,
    blockReason,
    warnings,
    pendingConfirm,
  };

  return <OrderFormCtx.Provider value={value}>{children}</OrderFormCtx.Provider>;
}

export const useOrderForm = () => useContext(OrderFormCtx);
export { money };
