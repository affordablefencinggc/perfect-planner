import "./WorkHeader.css";

// Where a piece of work lives and how it is running: one structured block for the top of an inspector or task card.
// Each fact is [label, value, wide?]; a missing value renders as an em dash so the layout stays the same.
export function WorkHeader({ status, facts, badge, empty = "—", children }) {
  return (
    <section className="work-header" aria-label="Where this work lives">
      <div className="work-header-top">
        {status}
        {badge && <small className="work-header-badge">{badge}</small>}
      </div>
      <dl className="work-header-facts">
        {facts.map(([label, value, wide]) => (
          <div key={label} className={wide ? "wide" : undefined}>
            <dt>{label}</dt>
            <dd className={value ? undefined : "empty"}>{value || empty}</dd>
          </div>
        ))}
      </dl>
      {children}
    </section>
  );
}
