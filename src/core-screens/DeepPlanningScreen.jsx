import { CoreScreen } from "./CoreScreen.jsx";

export default function DeepPlanningScreen() {
  return <CoreScreen id="planning" title="Deep planning" empty={<strong>Nothing here yet</strong>} resource={{ status: "empty" }} />;
}
