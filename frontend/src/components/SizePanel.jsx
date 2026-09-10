import { useOrderForm, money } from "../context/OrderFormContext.jsx";

const CHIPS = [10000, 25000, 50000, 100000];

/** Budget + quantity — sits under the live-price panel, next to the price it sizes against. */
export default function SizePanel() {
  const {
    instrument,
    isEdit,
    investment,
    editInvestment,
    quantity,
    editQuantity,
    qtyManual,
    setQtyManual,
    unitPrice,
    budget,
    deployed,
    shortfall,
  } = useOrderForm();

  if (!instrument) return null;

  const bump = (setter, cur, step) => () =>
    setter(String(Math.max(0, Math.round((Number(cur) || 0) + step))));

  return (
    <div className="size-panel">
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
        {!isEdit && (
          <div className="quick">
            {CHIPS.map((v) => (
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
        )}
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
              ↺ back to ₹{money(budget)} budget
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
