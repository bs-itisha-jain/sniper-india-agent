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

const GttCtx = createContext(null);
const POLL_MS = 25_000;

export function GttProvider({ children }) {
  const { ready } = useBroker();
  const [gtts, setGtts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);
  const busyIds = useRef(new Set());

  const refresh = useCallback(async () => {
    if (!ready) {
      setGtts([]);
      setLoadedOnce(false);
      return;
    }
    setLoading(true);
    try {
      const { triggers } = await api.listGtt();
      setGtts(Array.isArray(triggers) ? triggers : []);
      setError("");
      setLoadedOnce(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [ready]);

  useEffect(() => {
    refresh();
    if (!ready) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [ready, refresh]);

  const cancel = useCallback(
    async (id) => {
      busyIds.current.add(id);
      try {
        await api.cancelGtt(id);
        await refresh();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        busyIds.current.delete(id);
      }
    },
    [refresh]
  );

  const modify = useCallback(
    async (id, payload) => {
      try {
        await api.updateGtt(id, payload);
        await refresh();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    [refresh]
  );

  const value = {
    gtts,
    loading,
    error,
    loadedOnce,
    refresh,
    cancel,
    modify,
    isBusy: (id) => busyIds.current.has(id),
  };

  return <GttCtx.Provider value={value}>{children}</GttCtx.Provider>;
}

export const useGtts = () => useContext(GttCtx);
