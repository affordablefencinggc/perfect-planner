import { FlaskIcon } from "@phosphor-icons/react";
import "./demoSample.css";

// Shared copy for every Demo control that cannot do anything real.
export const DEMO_ONLY_REASON = "Demo only — sample data";

// Persistent badge shown while the explicit Demo project is active.
export function DemoSampleBadge() {
  return (
    <div className="demo-sample-badge" role="status" aria-label="Demo — sample data" title="Everything shown in the Demo is sample data. Nothing here describes a real project, and Demo buttons do not change anything.">
      <FlaskIcon weight="fill" aria-hidden="true" /><span>Demo — sample data</span>
    </div>
  );
}

// Small visible reason placed next to a disabled Demo control.
export function DemoOnlyReason({ children, className = "" }) {
  return <small className={`demo-only-reason${className ? ` ${className}` : ""}`}>{DEMO_ONLY_REASON}{children ? <> · {children}</> : null}</small>;
}
