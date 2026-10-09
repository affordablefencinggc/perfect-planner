import { CoreScreen } from "./CoreScreen.jsx";

export default function PeopleScreen() {
  return <CoreScreen id="people" title="People" empty={<strong>Nothing here yet</strong>} resource={{ status: "empty" }} />;
}
