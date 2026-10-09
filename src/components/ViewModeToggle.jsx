import { useViewMode } from "../project/viewMode.js";

const OPTIONS = [
  { mode: "simple", label: "Simple", title: "Plain-language outcomes and next actions" },
  { mode: "advanced", label: "Advanced", title: "Also show IDs, fingerprints, revisions and scan numbers" },
];

// Switching view only changes what is displayed; it never changes project data or protections.
export function ViewModeToggle({ className = "" }) {
  const { mode, setMode } = useViewMode();
  return (
    <div className={`view-mode-toggle${className ? ` ${className}` : ""}`} role="group" aria-label="View detail level">
      {OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          aria-pressed={mode === option.mode}
          title={option.title}
          onClick={() => setMode(option.mode)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
