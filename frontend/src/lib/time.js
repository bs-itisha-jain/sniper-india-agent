/** "2h 5m ago" / "in 19h" — rounds to whole minutes so 59.7m never shows as 60m. */
export function relative(iso, { future = false } = {}) {
  if (!iso) return "—";
  const diff = future
    ? new Date(iso).getTime() - Date.now()
    : Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  const wrap = (label) => (future ? `in ${label}` : `${label} ago`);

  if (s < 60) return wrap(`${s}s`);

  const mins = Math.round(s / 60);
  if (mins < 60) return wrap(`${mins}m`);

  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const m = mins % 60;
    return wrap(m ? `${hours}h ${m}m` : `${hours}h`);
  }
  return wrap(`${Math.round(hours / 24)}d`);
}

export const clockTime = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
