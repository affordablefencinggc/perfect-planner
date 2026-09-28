// Display labels are separate from the full opaque identity used for custody.
export function projectLabelFromRoot(rootPath) {
  const root = String(rootPath ?? "").replaceAll("\\", "/");
  if (!root.startsWith("browser://"))
    return root.split("/").filter(Boolean).at(-1) || "Imported project";
  const encoded = root.slice("browser://".length).split("/")[0];
  if (!encoded) return "Imported project";
  try { return decodeURIComponent(encoded); }
  catch { return encoded; }
}

// Preserve the historical registration-ID input independently of display fixes.
// Existing registrations must not change identity when their label is corrected.
export function projectRegistrationLabelFromRoot(rootPath) {
  const encoded = String(rootPath ?? "").replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "Imported project";
  try { return decodeURIComponent(encoded); }
  catch { return encoded; }
}
