import "./helpers/hermetic-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assessPeerReview, openPortableProviderVault, openProviderVault, redactProviderVault, sealPortableProviderVault, sealProviderVault } from "../src/node/providerReview.mjs";

const providers = [{ providerId: "provider-a", apiKey: "secr" + "et-key-a" }, { providerId: "provider-b", apiKey: "secr" + "et-key-b" }];
const finding = (verdict = "clear") => ({ verdict, evidence: `${verdict} evidence` });
const review = (providerId, overrides = {}) => ({ providerId, promptHash: "p".repeat(64), artifactHash: "a".repeat(64), completedAt: "2026-09-02T00:00:00.000Z", findings: { architecture: finding(), security: finding(), tests: finding(), debt: finding(), ...overrides } });

test("vault accepts exactly two or three unique providers", () => {
  assert.throws(() => sealProviderVault([providers[0]], "long-enough-passphrase"), /two or three/); assert.throws(() => sealProviderVault([...providers, providers[0]], "long-enough-passphrase"), /unique/);
});

test("sealed vault exposes no API key plaintext and opens with the passphrase", () => {
  const vault = sealProviderVault(providers, "long-enough-passphrase"); const serialized = JSON.stringify(vault); assert.equal(serialized.includes("secret-key"), false); assert.deepEqual(openProviderVault(vault, "long-enough-passphrase"), providers);
});

test("wrong passphrases and ciphertext tampering fail authentication", () => {
  const vault = sealProviderVault(providers, "long-enough-passphrase"); assert.throws(() => openProviderVault(vault, "wrong-passphrase-long"), /authentication failed/); const changed = { ...vault, ciphertext: `${vault.ciphertext.slice(0,-2)}AA` }; assert.throws(() => openProviderVault(changed, "long-enough-passphrase"), /authentication failed/);
});

test("redacted vault metadata never returns encrypted material or keys", () => {
  const redacted = redactProviderVault(sealProviderVault(providers, "long-enough-passphrase")); assert.equal(redacted.secrets, "REDACTED"); assert.equal("ciphertext" in redacted, false); assert.equal("authTag" in redacted, false);
});

test("passphrase custody is explicitly labelled as a portable non-OS-backed fallback", () => {
  const vault = sealPortableProviderVault(providers, "long-enough-passphrase");
  assert.equal(vault.custody, "PORTABLE_FALLBACK_NOT_OS_BACKED");
  assert.deepEqual(openPortableProviderVault(vault, "long-enough-passphrase"), providers);
  assert.equal(redactProviderVault(vault).custody, "PORTABLE_FALLBACK_NOT_OS_BACKED");
});

test("duplicate providers cannot satisfy independent quorum", () => {
  const result = assessPeerReview({ reviews: [review("same"), review("same")], requiredQuorum: 2 }); assert.equal(result.ready, false); assert.ok(result.blockers.some((item) => item.includes("unique")));
});

test("block findings and disagreements require explicit disposition", () => {
  const result = assessPeerReview({ reviews: [review("a"), review("b", { security: finding("block") })], requiredQuorum: 2 }); assert.equal(result.ready, false); assert.equal(result.criticalBlocks.length, 1); assert.equal(result.disagreements.length, 1);
});

test("two complete independent clear reviews satisfy quorum", () => {
  const result = assessPeerReview({ reviews: [review("a"), review("b")], requiredQuorum: 2 }); assert.equal(result.ready, true); assert.equal(result.verdict, "QUORUM_CLEAR"); assert.deepEqual(result.areas, ["architecture", "security", "tests", "debt"]);
});
