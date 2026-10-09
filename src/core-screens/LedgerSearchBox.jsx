import { useEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import "./LedgerSearchBox.css";

// Header search box for ledger numbers and clauses ("P-12 §3.2", "R-5").
// Enter hands the query to the Ledger search screen (workspace "lookup")
// through sessionStorage plus a window event, then asks the shell to open it.

export const LEDGER_LOOKUP_EVENT = "pp:ledger-lookup";
const STORAGE_KEY = "perfect-planner.ledger-lookup.query";
let pendingQuery = null;

/** Hands a query to the lookup screen, whether or not it is mounted yet. */
export function requestLedgerLookup(query) {
  const text = String(query ?? "").trim();
  if (!text) return;
  pendingQuery = text;
  try { window.sessionStorage?.setItem(STORAGE_KEY, text); } catch { /* storage blocked: the module store still has it */ }
  try { window.dispatchEvent(new CustomEvent(LEDGER_LOOKUP_EVENT, { detail: { query: text } })); } catch { /* no window */ }
}

/** Takes the query handed over by the header box, once. */
export function takeLedgerLookup() {
  let text = pendingQuery;
  pendingQuery = null;
  try {
    const stored = window.sessionStorage?.getItem(STORAGE_KEY);
    if (stored) text = text ?? stored;
    window.sessionStorage?.removeItem(STORAGE_KEY);
  } catch { /* storage blocked */ }
  return text || null;
}

/** "s3.2", "sec 3.2" and "section 3.2" become "§3.2" as people type. */
export function withSectionSign(text) {
  return String(text ?? "")
    .replace(/(^|\s)(?:section|sec\.?|s)\s*(?=\d)/gi, "$1§")
    .replace(/§\s+(?=\d)/g, "§");
}

function isTypingTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

export function LedgerSearchBox({ onWorkspace }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (event) => {
    event.preventDefault();
    const text = withSectionSign(value).trim();
    if (!text) return;
    requestLedgerLookup(text);
    onWorkspace?.("lookup");
    setValue("");
    inputRef.current?.blur();
  };

  return (
    <form className="ledger-search-box" role="search" aria-label="Ledger search" onSubmit={submit}>
      <MagnifyingGlassIcon className="ledger-search-box-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => setValue(withSectionSign(event.target.value))}
        onKeyDown={(event) => { if (event.key === "Escape") { setValue(""); event.currentTarget.blur(); } }}
        placeholder="Find P-12 §3.2, R-5…"
        aria-label="Find a plan clause, release, task or ledger entry"
        aria-keyshortcuts="/"
        autoComplete="off"
        spellCheck={false}
      />
      <kbd className="ledger-search-box-key" aria-hidden="true">/</kbd>
    </form>
  );
}
