/**
 * Per-member encryption keys for verifiable encrypted resharing (docs/pvss-reshare.md, phase 1).
 *
 *   node --test test/custody-enckey.test.ts
 *
 * Each committee member derives an X25519 encryption key from its Ed25519 producer seed and binds it to
 * its id; peers admit a key only if the binding verifies. Proven here, then composed with the pvss
 * primitive: derived keys really do seal + open a deal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as ed from "../src/det/ed25519.ts";
import { deriveEncKey, bindEncKey, verifyEncKeyBinding, announceEncKey, EncKeyRegistry } from "../src/custody/enckey.ts";
import { dealVerifiable, openShare } from "../src/custody/pvss.ts";
import { randScalar } from "../src/custody/shamir.ts";
import { toHex } from "../src/det/canonical.ts";

test("deriveEncKey is deterministic from the producer seed (no new persisted secret)", () => {
	const kp = ed.generateKeyPair();
	const a = deriveEncKey(kp.privateKey);
	const b = deriveEncKey(kp.privateKey);
	assert.deepEqual(a.publicKey, b.publicKey, "same seed → same encryption key");
	assert.deepEqual(a.privateKey, b.privateKey);
	assert.notDeepEqual(a.publicKey, deriveEncKey(ed.generateKeyPair().privateKey).publicKey, "different seed → different key");
});

test("bind/verify ties the encryption key to the committee id", () => {
	const kp = ed.generateKeyPair();
	const id = toHex(kp.publicKey);
	const enc = deriveEncKey(kp.privateKey);
	const binding = bindEncKey(kp.privateKey, enc.publicKey);

	assert.equal(verifyEncKeyBinding(id, enc.publicKey, binding), true, "honest binding verifies");

	const other = ed.generateKeyPair();
	assert.equal(verifyEncKeyBinding(toHex(other.publicKey), enc.publicKey, binding), false, "wrong id rejected");
	assert.equal(verifyEncKeyBinding(id, deriveEncKey(other.privateKey).publicKey, binding), false, "wrong key rejected");
	assert.equal(verifyEncKeyBinding(id, enc.publicKey, "00" + binding.slice(2)), false, "tampered binding rejected");
});

test("the registry admits valid announcements and rejects forgeries", () => {
	const reg = new EncKeyRegistry();
	const kp = ed.generateKeyPair();
	const id = toHex(kp.publicKey);

	assert.equal(reg.learn(announceEncKey(kp.privateKey, id)), true, "valid announcement admitted");
	assert.deepEqual(reg.get(id), deriveEncKey(kp.privateKey).publicKey, "registry returns the verified key");
	assert.equal(reg.has(id), true);

	const victim = ed.generateKeyPair();
	const mine = announceEncKey(kp.privateKey, id);
	assert.equal(reg.learn({ ...mine, id: toHex(victim.publicKey) }), false, "can't bind my key to someone else's id");
	assert.equal(reg.learn({ ...mine, encPub: toHex(deriveEncKey(victim.privateKey).publicKey) }), false, "swapped encPub rejected");
	assert.deepEqual(reg.missing([id, toHex(victim.publicKey)]), [toHex(victim.publicKey)], "missing() flags unknown ids");
});

test("enckey + pvss compose: derived keys seal and open a real deal", () => {
	const reg = new EncKeyRegistry();
	const ms = [0, 1, 2].map(() => ed.generateKeyPair());
	const ids = ms.map((k) => toHex(k.publicKey));
	ms.forEach((k, i) => assert.equal(reg.learn(announceEncKey(k.privateKey, ids[i])), true));

	const deal = dealVerifiable("dealer", randScalar(), ids, 2, (id) => reg.get(id)!);
	// each member opens its sub-share using ONLY its producer seed (derives the same enc key)
	ms.forEach((k, i) => assert.equal(typeof openShare(deal, ids[i], deriveEncKey(k.privateKey)), "bigint", `${ids[i].slice(0, 8)} opens its share`));
});
