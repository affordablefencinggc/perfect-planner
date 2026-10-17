// Types for the collision engine's file-claim patterns, which core/gate's tests compare the contract's path rules against.
declare module "*/src/engine/claimPatterns.js" {
  export function claimPatternProblem(path: string): string | null;
  export function claimPatternsOverlap(left: string, right: string): boolean;
}
