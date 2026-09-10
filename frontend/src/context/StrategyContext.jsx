import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client.js";
import { useBroker } from "./BrokerContext.jsx";
import {
  SL_PCT,
  ocoLegs,
  phase1SlQty,
  reversedQty as leftoverQty,
  exitActionFor,
  orderMatchesLeg,
} from "../lib/strategy.js";

const StrategyCtx = createContext(null);
const POLL_MS = 8000;
const LS_KEY = "sniper.strategy.v1";

/* states: idle | awaiting_entry | phase1 | phase2 | done_win | done_loss | error */

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function persist(s) {
  try {
    if (s) localStorage.setItem(LS_KEY, JSON.stringify(s));
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* private mode — run in memory only */
  }
}

const now = () => new Date().toISOString();

export function StrategyProvider({ children }) {
  const { ready } = useBroker();
  const [strat, setStrat] = useState(load);
  const [busy, setBusy] = useState(false);
  const advancing = useRef(false);

  const update = useCallback((patch, event) => {
    setStrat((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        ...patch,
        updatedAt: now(),
        events: event ? [...(prev.events || []), { at: now(), text: event }] : prev.events,
      };
      persist(next);
      return next;
    });
  }, []);

  /** Kick off a fresh strategy: place the entry GTT, then watch it. */
  const start = useCallback(
    async ({ symbol, tradingsymbol, exchange, side, qty, triggerPrice, limitPrice, product }) => {
      setBusy(true);
      try {
        const res = await api.createGtt({
          symbol,
          action: side,
          quantity: qty,
          trigger_price: triggerPrice,
          price: limitPrice,
          product,
        });
        const entryGttId = res?.gtt?.trigger_id ?? null;
        const fresh = {
          id: `${tradingsymbol}-${Date.now()}`,
          symbol,
          tradingsymbol,
          exchange,
          side,
          qty,
          product,
          slPct: SL_PCT,
          state: "awaiting_entry",
          startedAt: now(),
          updatedAt: now(),
          entryGttId,
          entryLimit: limitPrice,
          events: [{ at: now(), text: `Entry GTT #${entryGttId ?? "?"} placed — ${side} ${qty} @ ₹${limitPrice}` }],
        };
        persist(fresh);
        setStrat(fresh);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        setBusy(false);
      }
    },
    []
  );

  /** Abandon: cancel any live GTTs and clear the strategy. */
  const stop = useCallback(async () => {
    setBusy(true);
    const ids = [strat?.entryGttId, strat?.phase1?.gttId, strat?.phase2?.gttId].filter(Boolean);
    for (const id of ids) {
      try {
        await api.cancelGtt(id);
      } catch {
        /* already gone / triggered */
      }
    }
    persist(null);
    setStrat(null);
    setBusy(false);
  }, [strat]);

  const clear = useCallback(() => {
    persist(null);
    setStrat(null);
  }, []);

  /** One advance pass — poll orders + GTTs and move the machine forward. */
  const tick = useCallback(async () => {
    if (advancing.current) return;
    const s = strat;
    if (!s || !ready) return;
    if (!["awaiting_entry", "phase1", "phase2"].includes(s.state)) return;

    advancing.current = true;
    try {
      const [{ orders = [] }, { triggers = [] }] = await Promise.all([
        api.orders(),
        api.listGtt(),
      ]);
      const gttById = (id) => triggers.find((t) => String(t.id) === String(id));

      if (s.state === "awaiting_entry") {
        const fill = orders.find((o) =>
          orderMatchesLeg(o, {
            tradingsymbol: s.tradingsymbol,
            action: s.side,
            quantity: s.qty,
            since: s.startedAt,
          })
        );
        if (!fill) return;
        const entryPrice = Number(fill.average_price) || s.entryLimit;
        const slQty = phase1SlQty(s.qty);
        const legs = ocoLegs({
          side: s.side,
          entryPrice,
          slQty,
          targetQty: s.qty,
          pct: s.slPct,
        });
        const oco = await api.placeOco({
          symbol: s.symbol,
          product: s.product,
          ...legs,
        });
        update(
          {
            state: "phase1",
            entryOrderId: fill.order_id,
            entryPrice,
            phase1: { gttId: oco?.gtt?.trigger_id ?? null, slQty, targetQty: s.qty, legs, armedAt: now() },
          },
          `Entry filled @ ₹${entryPrice}. Phase 1 OCO armed — target ${s.qty}@₹${legs.target_trigger} / SL ${slQty}@₹${legs.sl_trigger}`
        );
        return;
      }

      if (s.state === "phase1") {
        const g = gttById(s.phase1.gttId);
        const stillLive = g && g.status === "active";
        if (stillLive) return;

        const exitAction = exitActionFor(s.side);
        const targetFill = orders.find((o) =>
          orderMatchesLeg(o, {
            tradingsymbol: s.tradingsymbol,
            action: exitAction,
            quantity: s.phase1.targetQty,
            since: s.phase1.armedAt,
          })
        );
        if (targetFill) {
          update({ state: "done_win", finishedAt: now(), outcome: "phase1_target" },
            `Phase 1 TARGET hit @ ₹${targetFill.average_price}. Cycle complete — profit.`);
          return;
        }

        const slFill = orders.find((o) =>
          orderMatchesLeg(o, {
            tradingsymbol: s.tradingsymbol,
            action: exitAction,
            quantity: s.phase1.slQty,
            since: s.phase1.armedAt,
          })
        );
        if (slFill) {
          const reversePrice = Number(slFill.average_price) || s.phase1.legs.sl_trigger;
          const revSide = s.side === "BUY" ? "SELL" : "BUY";
          const revQty = leftoverQty(s.qty); // 2.5·Q
          const legs = ocoLegs({
            side: revSide,
            entryPrice: reversePrice,
            slQty: revQty,
            targetQty: revQty,
            pct: s.slPct,
          });
          const oco = await api.placeOco({ symbol: s.symbol, product: s.product, ...legs });
          update(
            {
              state: "phase2",
              reverseOrderId: slFill.order_id,
              reversePrice,
              reversedSide: revSide,
              reversedQty: revQty,
              phase2: { gttId: oco?.gtt?.trigger_id ?? null, legs, armedAt: now() },
            },
            `Phase 1 SL hit → reversed to ${revSide} ${revQty} @ ₹${reversePrice}. Phase 2 OCO armed — target ₹${legs.target_trigger} / SL ₹${legs.sl_trigger}`
          );
          return;
        }
        return; // GTT gone but no matching fill yet — wait for the order book to catch up
      }

      if (s.state === "phase2") {
        const g = gttById(s.phase2.gttId);
        if (g && g.status === "active") return;

        const exitAction = exitActionFor(s.reversedSide);
        const fill = orders.find((o) =>
          orderMatchesLeg(o, {
            tradingsymbol: s.tradingsymbol,
            action: exitAction,
            quantity: s.reversedQty,
            since: s.phase2.armedAt,
          })
        );
        if (!fill) return;
        const px = Number(fill.average_price);
        const isLongExit = exitAction === "SELL";
        const won = isLongExit ? px >= s.reversePrice : px <= s.reversePrice;
        update(
          { state: won ? "done_win" : "done_loss", finishedAt: now(), outcome: won ? "phase2_target" : "phase2_sl" },
          `Phase 2 ${won ? "TARGET" : "SL"} hit @ ₹${px}. Cycle complete — ${won ? "recovered + profit" : "loss taken. STOP."}`
        );
      }
    } catch (err) {
      update({ state: "error", message: err.message }, `Error: ${err.message}`);
    } finally {
      advancing.current = false;
    }
  }, [strat, ready, update]);

  useEffect(() => {
    if (!strat) return undefined;
    tick();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [strat, tick]);

  const value = { strat, busy, start, stop, clear, tick };
  return <StrategyCtx.Provider value={value}>{children}</StrategyCtx.Provider>;
}

export const useStrategy = () => useContext(StrategyCtx);
