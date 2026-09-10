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

/** GTT trigger sits this far from the live price by default. */
const TRIGGER_OFFSET = 0.1;
/** Default budget — quantity is derived from this and the price. */
const DEFAULT_INVESTMENT = 25000;

/** Fat-finger thresholds. */
const BIG_VALUE = 200_000; // ₹ — flag orders above this
const TRIGGER_FAR_PCT = 10; // trigger this far from LTP → flag
const LIMIT_OFF_PCT = 3; // limit this far from trigger → flag
const CONFIRM_WINDOW_MS = 5000;

/* Order kinds. GTT waits for a trigger; LIMIT and MARKET fire straight away. */
const KINDS = ["gtt", "limit", "market"];

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
  kind: "gtt",
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
  const [kind, setKindRaw] = useState(BLANK.kind);
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

  const isGtt = kind === "gtt";
  const isMarket = kind === "market";
  const needsTrigger = isGtt;
  const needsLimit = !isMarket;

  const clearConfirm = useCallback(() => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setPendingConfirm(false);
  }, []);

  const setKind = useCallback(
    (next) => {
      if (!KINDS.includes(next)) return;
      setKindRaw(next);
      clearConfirm();
      setStatus(null);
    },
    [clearConfirm]
  );

  const resetForm = useCallback(() => {
    setAction(BLANK.action);
    setQuantity(BLANK.quantity);
    setTrigger(BLANK.trigger);
    setLimit(BLANK.limit);
    setProduct(BLANK.product);
    setKindRaw(BLANK.kind);
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
    setKindRaw("gtt"); // an existing GTT is always edited as a GTT
    touched.current = { trigger: true, limit: true };
    setQtyManual(true); // the GTT's own quantity wins in edit mode
    prefilledFor.current = key;
    setPrefilled(false);
    setStatus(null);
    clearConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Prefill from LTP — create mode only. Limit = LTP, trigger = LTP − ₹0.10.
  useEffect(() => {
    if (isEdit || !key || !(ltp > 0) || prefilledFor.current === key) return;
    prefilledFor.current = key;
    const below = ltp - TRIGGER_OFFSET;
    if (!touched.current.limit) setLimit(ltp.toFixed(2));
    if (!touched.current.trigger) setTrigger((below > 0 ? below : ltp).toFixed(2));
    setPrefilled(true);
  }, [isEdit, key, ltp]);

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
      touched.current.limit = true;
      setPrefilled(false);
      clearConfirm();
      setLimit(v);
    },
    [clearConfirm]
  );

  const q = Number(quantity);
  const t = Number(trigger);
  const l = Number(limit);
  const budget = Number(investment);

  /** What a share actually costs for sizing. */
  const unitPrice = isMarket
    ? ltp > 0
      ? ltp
      : 0
    : l > 0
      ? l
      : ltp > 0
        ? ltp
        : 0;

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
    if (needsTrigger && !(t > 0)) list.push("Set a trigger price");
    if (needsLimit && !(l > 0)) list.push("Set a limit price");
    return list;
  }, [instrument, q, t, l, needsTrigger, needsLimit]);

  const formOk = problems.length === 0;
  const estValue = formOk ? q * unitPrice : 0;

  // Fat-finger warnings — informational, not blocking
  const warnings = useMemo(() => {
    if (!formOk) return [];
    const w = [];
    if (estValue > BIG_VALUE) w.push(`Large order — ₹${money(estValue)}`);
    if (isGtt && ltp > 0) {
      const trigPct = ((t - ltp) / ltp) * 100;
      if (Math.abs(trigPct) > TRIGGER_FAR_PCT)
        w.push(`Trigger is ${trigPct > 0 ? "+" : ""}${trigPct.toFixed(1)}% from LTP`);
      const limPct = ((l - t) / t) * 100;
      if (Math.abs(limPct) > LIMIT_OFF_PCT)
        w.push(`Limit is ${limPct > 0 ? "+" : ""}${limPct.toFixed(1)}% off the trigger`);
    }
    return w;
  }, [formOk, estValue, isGtt, ltp, t, l]);

  const needsLive = !isEdit; // every kind sizes/prices off the live price
  const canSubmit = formOk && tokenReady && !(ltpStale && needsLive);
  const blockReason = !formOk
    ? problems[0]
    : !tokenReady
      ? "Broker not connected"
      : ltpStale && needsLive
        ? "Live price is stale — refresh it before placing"
        : null;

  const run = async () => {
    clearConfirm();
    const symbol = `${instrument.exchange}:${instrument.tradingsymbol}`;
    setBusy(true);
    try {
      if (isEdit) {
        setStatus({ type: "info", msg: "Updating GTT…" });
        await api.updateGtt(editing.id, {
          symbol,
          action,
          quantity: q,
          trigger_price: t,
          price: l,
          product,
        });
        setStatus({ type: "ok", msg: `GTT #${editing.id} updated.` });
        onEditDone?.();
        refreshGtts?.();
      } else if (isGtt) {
        setStatus({ type: "info", msg: "Placing GTT…" });
        const res = await api.createGtt({
          symbol,
          action,
          quantity: q,
          trigger_price: t,
          price: l,
          product,
        });
        const id = res?.gtt?.trigger_id;
        setStatus({ type: "ok", msg: `GTT armed${id ? ` · #${id}` : ""}.` });
        refreshGtts?.();
      } else {
        const orderType = isMarket ? "MARKET" : "LIMIT";
        setStatus({ type: "info", msg: `Placing ${orderType} order…` });
        const res = await api.placeOrder({
          symbol,
          action,
          quantity: q,
          order_type: orderType,
          ...(isMarket ? {} : { price: l }),
          product,
        });
        const id = res?.order_id;
        setStatus({
          type: "ok",
          msg: `${orderType} order placed${id ? ` · ${id}` : ""}.`,
        });
      }
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
    // order kind
    kind,
    setKind,
    isGtt,
    isMarket,
    needsTrigger,
    needsLimit,
    // field state + setters
    action,
    setAction,
    trigger,
    editTrigger,
    limit,
    editLimit,
    product,
    setProduct,
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
    TRIGGER_OFFSET,
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
