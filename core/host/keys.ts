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

type EnsuringProvider = KeyProvider & ({ ensureKey(principal: string): TrustedKey } | { createKey(principal: string): TrustedKey });

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

  /**
   * Makes a key if it is missing: the system key any time, a person's key only inside that
   * person's own request (otherwise nothing happens and the ledger refuses an unsigned write).
   */
  ensure(principal: string): void {
    if (!this.inner.state().available) return;
    if (principal.startsWith("person:") && personRequest.getStore() !== true) return;
    this.make(principal);
  }

  /** The app's own key for gate, watcher and planner entries. */
  ensureSystemKey(): void {
    if (!this.inner.state().available) return;
    this.make("system");
  }

  /**
   * The owner's key for a project being created: made by the app itself (not by any request) so its
   * id can be pinned outside the ledger before anyone writes (core/host/owner.ts).
   */
  ownerKeyFor(principal: string): string | undefined {
    if (!this.inner.state().available) return undefined;
    this.make(principal);
    return this.active(principal)?.keyId;
  }

  /** Staging a person's next key (ledger.rotateKey) happens only inside that person's own request. */
  stageKey(principal: string): TrustedKey {
    this.personOnly(principal, "make a new key");
    if (!this.inner.stageKey) throw new Error(`${this.inner.description} cannot stage keys, so keys cannot be rotated here.`);
    return this.inner.stageKey(principal);
  }

  activateKey(principal: string, keyId: string): void {
    this.personOnly(principal, "switch keys");
    if (!this.inner.activateKey) throw new Error(`${this.inner.description} cannot stage keys, so keys cannot be rotated here.`);
    this.inner.activateKey(principal, keyId);
  }

  discardStagedKey(principal: string): void {
    this.inner.discardStagedKey?.(principal);
  }

  /** The app's own signature over bytes it keeps outside the ledger (the owner pin). */
  signForApp(message: Buffer): { keyId: string; signature: string } | undefined {
    if (!this.inner.state().available) return undefined;
    this.make("system");
    return this.inner.sign("system", message);
  }

  /** The app's system key with this id, if this device trusts it. */
  systemKey(keyId: string): TrustedKey | undefined {
    return this.inner.trustedKeys().find((k) => k.principal === "system" && k.keyId === keyId);
  }

  private active(principal: string): TrustedKey | undefined {
    return this.inner.trustedKeys().find((k) => k.principal === principal && !k.retired);
  }

  private personOnly(principal: string, what: string): void {
    if (principal.startsWith("person:") && personRequest.getStore() !== true) throw new Error(`Only the person's own request can ${what} for ${principal}.`);
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
