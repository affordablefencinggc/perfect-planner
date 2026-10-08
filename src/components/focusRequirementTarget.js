// Brings the panel that owns a requirement into view on the current page.
// A feature panel opts in with data-requirement-target="ID [ID…]"; otherwise the
// requirement's own row ([data-requirement-id]) is used. Returns the focused element.
export function focusRequirementTarget(root, requirementId) {
  if (!root || !requirementId) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(requirementId) : requirementId.replace(/["\\]/g, "\\$&");
  const element = root.querySelector(`[data-requirement-target~="${escaped}"]`) ?? root.querySelector(`[data-requirement-id="${escaped}"]`);
  if (!element) return null;
  element.scrollIntoView?.({ behavior: "smooth", block: "start" });
  element.focus?.({ preventScroll: true });
  return element;
}
