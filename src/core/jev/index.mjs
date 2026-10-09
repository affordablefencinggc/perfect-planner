// Public surface of the Jev module (atlas C065).
// The stored key is reachable only through keychain.providerKeySource(),
// which is deliberately not re-exported here.
export { createJev, sameModel, spentFromLedger, VERDICTS } from "./reviewer.mjs";
export { createTypeSafeProvider, ProviderError, TYPESAFE_DEFAULTS } from "./provider.mjs";
export { precheckDiff, parseUnifiedDiff, isTestPath, inScope, SECRET_RULES } from "./precheck.mjs";
export { setJevKey, hasJevKey, clearJevKey, createSystemKeychain, createMemoryKeychain, KeychainError, JEV_KEY_SERVICE, JEV_KEY_ACCOUNT } from "./keychain.mjs";

import { createTypeSafeProvider } from "./provider.mjs";
import { providerKeySource } from "./keychain.mjs";

/** The production provider: TypeSafe Jev with the key read from the OS keychain at call time. */
export function createKeychainJevProvider({ settings, keychain, fetchImpl } = {}) {
  return createTypeSafeProvider({ getApiKey: providerKeySource({ keychain }), settings, fetchImpl });
}
