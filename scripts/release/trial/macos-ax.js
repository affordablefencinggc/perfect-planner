// JXA helper for the macOS installer trial: reads and presses the app's accessibility tree.
//   osascript -l JavaScript macos-ax.js windows <bundle id>
//   osascript -l JavaScript macos-ax.js text <bundle id>
//   osascript -l JavaScript macos-ax.js press <bundle id> <case-insensitive regex> [first|last]
//   osascript -l JavaScript macos-ax.js key <bundle id> escape
function run(argv) {
  const [command, bundleId, pattern, which] = argv;
  const se = Application("System Events");
  const procs = se.processes.whose({ bundleIdentifier: bundleId })();
  if (!procs.length) return `no process for ${bundleId}`;
  const proc = procs[0];
  if (command === "windows") {
    const wins = proc.windows();
    return `windows: count=${wins.length} ${wins.map((w) => JSON.stringify(w.name())).join(" ")}`;
  }
  if (command === "key") {
    proc.frontmost = true;
    se.keyCode(53);
    return "key sent";
  }
  const seen = [];
  const matches = [];
  const loose = []; // labelled non-button elements, e.g. the text inside a WebView button
  const re = pattern ? new RegExp(pattern, "i") : null;
  const visit = (el, depth) => {
    if (depth > 40 || seen.length > 4000) return;
    let role = "", name = "", value = "", desc = "";
    try { role = el.role(); } catch (e) {}
    try { name = el.title() || ""; } catch (e) {}
    try { desc = el.description() || ""; } catch (e) {}
    try { const v = el.value(); value = typeof v === "string" ? v : ""; } catch (e) {}
    const label = [name, desc, value].filter(Boolean).join(" | ");
    if (label) seen.push(label);
    if (re && (re.test(name.trim()) || re.test(desc.trim()) || re.test(value.trim()))) (/button|link|menuitem/i.test(role) ? matches : loose).push(el);
    let kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (const kid of kids) visit(kid, depth + 1);
  };
  for (const w of proc.windows()) visit(w, 0);
  if (command === "text") return seen.join("\n");
  if (command === "press") {
    if (!matches.length) matches.push(...loose);
    if (!matches.length) return `no element matching /${pattern}/i among ${seen.length} labelled elements`;
    const el = which === "last" ? matches[matches.length - 1] : matches[0];
    proc.frontmost = true;
    try { el.actions.byName("AXPress").perform(); } catch (e) { el.click(); }
    return `pressed /${pattern}/i (${which === "last" ? "last" : "first"} of ${matches.length})`;
  }
  return `unknown command ${command}`;
}
