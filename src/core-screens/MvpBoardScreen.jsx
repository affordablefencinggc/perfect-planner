import { CoreScreen } from "./CoreScreen.jsx";

export default function MvpBoardScreen() {
  return <CoreScreen id="mvp" title="MVP board" empty={<strong>Nothing here yet</strong>} resource={{ status: "empty" }} />;
}
