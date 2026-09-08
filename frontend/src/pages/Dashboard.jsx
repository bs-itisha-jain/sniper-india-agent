import { useCallback, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { BrokerProvider, useBroker } from "../context/BrokerContext.jsx";
import { GttProvider } from "../context/GttContext.jsx";
import Rail from "../components/Rail.jsx";
import BrokerPill from "../components/BrokerPill.jsx";
import ConnectBar from "../components/ConnectBar.jsx";
import SymbolSearch from "../components/SymbolSearch.jsx";
import TargetCard from "../components/TargetCard.jsx";
import OrderTicket from "../components/OrderTicket.jsx";

function Desk() {
  const { user, logout } = useAuth();
  const { ready: tokenReady } = useBroker();

  const [instrument, setInstrument] = useState(null);
  const [ltp, setLtp] = useState(null);
  const [ltpStale, setLtpStale] = useState(false);
  const [editing, setEditing] = useState(null);
  const [resetSignal, setResetSignal] = useState(0);

  const pick = useCallback((next) => {
    setInstrument(next);
    setLtp(null);
    setLtpStale(false);
    setEditing(null);
  }, []);

  const clearAll = useCallback(() => {
    setInstrument(null);
    setLtp(null);
    setLtpStale(false);
    setEditing(null);
    setResetSignal((n) => n + 1);
  }, []);

  // "Modify" on a GTT row → load it into the ticket
  const editGtt = useCallback((g) => {
    setInstrument({ tradingsymbol: g.tradingsymbol, exchange: g.exchange || "NSE" });
    setLtp(null);
    setLtpStale(false);
    setEditing(g);
  }, []);

  return (
    <div className="shell">
      <Rail onEditGtt={editGtt} />

      <main className="stage">
        <header className="deskbar">
          <div className="deskbar-title">
            <span className="eyebrow">GTT desk</span>
            <h2>Set a target</h2>
          </div>
          <div className="who">
            <BrokerPill />
            <span className="who-sep" />
            <button
              className="btn ghost sm"
              onClick={clearAll}
              disabled={!instrument}
              title="Clear the symbol and every field"
            >
              Clear all
            </button>
            <span className="chip">
              <span className="av">{(user || "?").slice(0, 1).toUpperCase()}</span>
              {user}
            </span>
            <button className="btn ghost sm" onClick={logout}>
              Sign out
            </button>
          </div>
        </header>

        <ConnectBar />

        <div className="desk-top">
          <SymbolSearch onPick={pick} resetSignal={resetSignal} />
          <TargetCard instrument={instrument} onLtp={setLtp} onStale={setLtpStale} />
        </div>

        <OrderTicket
          instrument={instrument}
          ltp={ltp}
          ltpStale={ltpStale}
          tokenReady={tokenReady}
          resetSignal={resetSignal}
          editing={editing}
          onEditDone={() => setEditing(null)}
        />
      </main>
    </div>
  );
}

export default function Dashboard() {
  return (
    <BrokerProvider>
      <GttProvider>
        <Desk />
      </GttProvider>
    </BrokerProvider>
  );
}
