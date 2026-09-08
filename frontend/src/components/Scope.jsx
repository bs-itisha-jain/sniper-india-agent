export default function Scope({ className = "scope" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <line x1="12" y1="1.5" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22.5" />
      <line x1="1.5" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22.5" y2="12" />
      <circle className="dot" cx="12" cy="12" r="1.9" />
    </svg>
  );
}
