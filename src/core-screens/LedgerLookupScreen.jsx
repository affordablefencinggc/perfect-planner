import { CoreScreen } from "./CoreScreen.jsx";

export default function LedgerLookupScreen() {
  return <CoreScreen id="lookup" title="Ledger search" empty={<strong>Nothing here yet</strong>} resource={{ status: "empty" }} />;
}
