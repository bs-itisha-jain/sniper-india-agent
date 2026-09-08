import Scope from "./Scope.jsx";
import GttList from "./GttList.jsx";

export default function Rail({ onEditGtt }) {
  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="brand">
          <Scope />
          <span>Sniper</span>
        </div>
      </div>

      <div className="rail-sep" />

      <GttList onEdit={onEditGtt} />

      <div className="rail-foot">
        Broker session refreshes daily at 8:00 AM IST
      </div>
    </aside>
  );
}
