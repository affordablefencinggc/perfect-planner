// Some tests inspect the production build in dist/. Locally they skip with a
// reason when nothing has been built yet; under CI (CI=true) a missing build
// stays a failure, so a broken build step can never turn into a quiet skip.
import { existsSync } from "node:fs";

const built = existsSync(new URL("../../dist/client/index.html", import.meta.url));
export const requiresBuild = !built && !process.env.CI && "requires a production build (run npm run build, or npm run test:all)";
