import { CoreScreen } from "./CoreScreen.jsx";

export default function DecisionsScreen() {
  return <CoreScreen id="decisions" title="Decisions" empty={<strong>Nothing here yet</strong>} resource={{ status: "empty" }} />;
}
