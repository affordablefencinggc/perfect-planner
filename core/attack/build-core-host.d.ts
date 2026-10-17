// Types for scripts/build-core-host.mjs, which the attack suite uses to bundle a host it can kill.
declare module "*/scripts/build-core-host.mjs" {
  export function buildCoreHost(options?: { outDir?: string; standalone?: boolean; entries?: Record<string, string> }): Promise<string>;
}
