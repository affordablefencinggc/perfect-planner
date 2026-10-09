// Signing keys for the core host. Person and system ledger entries must be
// signed (core/ledger "Signatures"); the host is the app process that holds
// the keys, so it is the only place a KeyProvider is ever opened. Agents reach
// the ledger through the MCP bridge, whose writes are agent entries and are
// never signed.
//
// A person's key is made only while the host is handling that person's own
// request (the HttpOnly person cookie, same-origin app window), tracked with
// AsyncLocalStorage so an agent call running at the same time cannot borrow it.
// The system key (gate, watcher, planners) is made when a project opens.
import { AsyncLocalStorage } from "node:async_hooks";
import { KeychainKeyProvider, MemoryKeyProvider, type KeyProvider, type KeyState, type TrustedKey } from "../ledger/index";

const personRequest = new AsyncLocalStorage<boolean>();

/** Runs fn as the person's own request: their signing key may be made on first use inside it. */
export function asPersonRequest<T>(fn: () => T): T {
  return personRequest.run(true, fn);
}

type EnsuringProvider = KeyProvider & { rotateKey(principal: string): TrustedKey } & ({ ensureKey(principal: string): TrustedKey } | { createKey(principal: string): TrustedKey });

/** Wraps a provider so person keys are made only inside asPersonRequest. */
export class HostKeys implements KeyProvider {
  readonly description: string;
  constructor(private readonly inner: EnsuringProvider) {
    this.description = inner.description;
  }

  state(): KeyState {
    return this.inner.state();
  }

  trustedKeys(): TrustedKey[] {
    return this.inner.trustedKeys();
  }

  /** The app's own key for gate, watcher and planner entries. */
  ensureSystemKey(): void {
    if (!this.inner.state().available) return;
    this.make("system");
  }

  /**
   * A new key for this person; the old one never signs here again. Call only from the person's own
   * request, then retire the old key in each ledger it signed (rotatePersonKey does both).
   */
  rotate(principal: string): { oldKeyId: string | undefined; key: TrustedKey } {
    if (personRequest.getStore() !== true) throw new Error("Only the person's own request can rotate their key.");
    const oldKeyId = this.inner.trustedKeys().find((k) => k.principal === principal && !k.retired)?.keyId;
    return { oldKeyId, key: this.inner.rotateKey(principal) };
  }

  sign(principal: string, message: Buffer): { keyId: string; signature: string } {
    if (principal.startsWith("person:") && personRequest.getStore() === true && this.inner.state().available) {
      if (!this.inner.trustedKeys().some((k) => k.principal === principal && !k.retired)) this.make(principal);
    }
    return this.inner.sign(principal, message);
  }

  private make(principal: string): void {
    if ("ensureKey" in this.inner) this.inner.ensureKey(principal);
    else if (!this.inner.trustedKeys().some((k) => k.principal === principal && !k.retired)) this.inner.createKey(principal);
  }
}

/**
 * The host's key provider: the OS keychain, or PP_CORE_KEYS=memory for
 * throwaway keys in tests, CI and cloud previews (a restart loses them, and the
 * ledger then reports those entries as signed by a key this device does not trust).
 */
export function hostKeys(env: NodeJS.ProcessEnv = process.env): HostKeys {
  if (env.PP_CORE_KEYS === "memory") return new HostKeys(new MemoryKeyProvider({ autoCreate: false }));
  return new HostKeys(new KeychainKeyProvider());
}
