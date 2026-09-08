import { useEffect, useMemo, useRef, useState } from "react";
import { searchSymbols } from "../lib/instruments.js";

const cleanTicker = (raw) =>
  raw.trim().toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9:&-]/g, "");

export default function SymbolSearch({ onPick, onClear, resetSignal }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  // Local, instant — no network, no token needed.
  const results = useMemo(() => {
    const term = q.trim();
    return term.length >= 1 ? searchSymbols(term) : [];
  }, [q]);

  useEffect(() => setActive(0), [q]);

  // "Clear all" wipes the field and refocuses it
  useEffect(() => {
    if (!resetSignal) return;
    setQ("");
    setOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [resetSignal]);

  // "/" anywhere focuses the search
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // close on outside click
  useEffect(() => {
    const onDoc = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pickSymbol = (tradingsymbol) => {
    setQ(tradingsymbol);
    setOpen(false);
    onPick({ tradingsymbol, exchange: "NSE", synthetic: false });
  };

  // Empty the field → the whole ticket clears with it.
  const handleChange = (raw) => {
    setQ(raw);
    setOpen(true);
    if (raw.trim() === "") onClear?.();
  };

  const clearField = () => {
    setQ("");
    setOpen(false);
    onClear?.();
    inputRef.current?.focus();
  };

  const resolveTyped = () => {
    const sym = cleanTicker(q);
    if (!sym) return;
    const [ex, ts] = sym.includes(":") ? sym.split(":") : ["NSE", sym];
    setOpen(false);
    onPick({ tradingsymbol: ts, exchange: ex, synthetic: true });
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && results[active]) pickSymbol(results[active].tradingsymbol);
      else resolveTyped();
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showPanel = open && q.trim().length >= 1;
  const noMatch = showPanel && results.length === 0;

  return (
    <div className="search" ref={boxRef}>
      <div className="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search NSE symbol — e.g. RELIANCE, INFY, TATAMOTORS"
          autoComplete="off"
          spellCheck="false"
        />
        {q ? (
          <button
            type="button"
            className="search-clear"
            onClick={clearField}
            title="Clear symbol"
            aria-label="Clear symbol"
          >
            ✕
          </button>
        ) : (
          <span className="kbd">/</span>
        )}
      </div>

      {showPanel && (
        <div className="results" role="listbox">
          {results.map((r, i) => (
            <button
              key={r.tradingsymbol}
              type="button"
              className={`result ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pickSymbol(r.tradingsymbol)}
              role="option"
              aria-selected={i === active}
            >
              <span className="rsym">{r.tradingsymbol}</span>
              <span className="rex">NSE</span>
            </button>
          ))}

          {noMatch && (
            <div className="results-note">
              Not in the Nifty 500 list. Press{" "}
              <span className="kbd" style={{ display: "inline-block" }}>↵</span> to use “
              {cleanTicker(q) || "…"}” as an NSE symbol anyway.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
