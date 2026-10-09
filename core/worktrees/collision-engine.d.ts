// Types for the proven JS collision engine in src/engine, reused by the core loop.
declare module "*/src/engine/collisionEngine.js" {
  export interface Surface {
    kind: "file" | "api" | "database" | "dependency";
    surface: string;
    access?: "read" | "write";
  }
  export function normalizeSurface(kind: Surface["kind"], surface: string): string;
  export function surfacesOverlap(left: Surface, right: Surface): boolean;
  export function claimsConflict(left: Required<Surface>, right: Required<Surface>): boolean;
}
