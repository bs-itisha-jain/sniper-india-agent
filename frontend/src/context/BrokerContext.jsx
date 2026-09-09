import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client.js";

const BrokerCtx = createContext(null);
const POLL_MS = 20_000;

/** Pull a request_token out of a pasted redirect URL / query string. */
function findRequestToken(text) {
  const m = /[?&]request_token=([A-Za-z0-9._-]+)/.exec(text);
  return m ? m[1] : null;
}

export function BrokerProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [transportError, setTransportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginUrl, setLoginUrl] = useState("");
  const [, tick] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const s = await api.tokenStatus();
      if (!mounted.current) return;
      setStatus(s);
      setTransportError("");
    } catch (err) {
      if (mounted.current) setTransportError(err.message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [load]);

  // keep "expires in …" honest between polls
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const live = Boolean(status?.hasToken && status?.fresh);

  const phase = !status
    ? "checking"
    : busy
      ? "auth"
      : live
        ? "connected"
        : status.hasToken
          ? "expired"
          : "down";

  // prefetch the Zerodha login URL whenever a manual connect might be needed
  useEffect(() => {
    if (loginUrl) return;
    if (phase === "connected" || phase === "checking") return;
    api
      .loginUrl()
      .then((d) => setLoginUrl(d.loginUrl))
      .catch(() => {});
  }, [loginUrl, phase]);

  /** Accepts a raw access_token, a request_token, or a pasted redirect URL. */
  const connect = useCallback(
    async (raw) => {
      const input = String(raw || "").trim();
      if (!input) return { ok: false, error: "Paste your access token first." };
      setBusy(true);
      try {
        const rt = findRequestToken(input);
        if (rt) {
          await api.submitRequestToken(rt);
        } else if (/^https?:\/\//i.test(input)) {
          throw new Error(
            "That URL has no request_token in it — paste the access token instead."
          );
        } else {
          await api.setAccessToken(input);
        }
        await load();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const value = {
    status,
    phase,
    ready: live,
    busy,
    transportError,
    loginUrl,
    load,
    connect,
  };

  return <BrokerCtx.Provider value={value}>{children}</BrokerCtx.Provider>;
}

export const useBroker = () => useContext(BrokerCtx);
