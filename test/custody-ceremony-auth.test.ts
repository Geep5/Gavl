/**
 * Ceremony message authentication (gate #2, scale hardening) — every ceremony message
 * is signed by the committee key its `from` names, so a node on the (open) committee
 * sub-swarm topic can't impersonate a member to siphon its secret share or inject
 * forged commitments. Without auth the ceremonies behave exactly as before (tests
 * elsewhere); here auth is ON, with real-pubkey committee ids.
 *
 *   node --test test/custody-ceremony-auth.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { SignCoordinator } from "../src/custody/sign-coordinator.ts";
import { makeCeremonyAuth, verifyCeremony } from "../src/custody/ceremony-auth.ts";
import { verify } from "../src/custody/threshold.ts";
import { taprootOutputKey, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { generateKeyPair, keyPairFromSeed } from "../src/det/ed25519.ts";
import { toHex, sha256 } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

test("a stamped message verifies; tampering, a forged `from`, or a missing sig do not", () => {
	const kp = generateKeyPair();
	const id = toHex(kp.publicKey);
	const auth = makeCeremonyAuth(kp.privateKey);

	const m = auth.stamp({ d: "round1", session: "s", from: id, pkg: { $u8: "abcd" } });
	assert.ok(verifyCeremony(m), "genuine message verifies against its from");

	assert.ok(!verifyCeremony({ ...m, pkg: { $u8: "ffff" } }), "tampered content fails");
	assert.ok(!verifyCeremony({ ...m, session: "other" }), "tampered session fails");
	assert.ok(!verifyCeremony({ d: "round1", session: "s", from: id, pkg: { $u8: "abcd" } }), "no sig fails");

	// IMPERSONATION: attacker signs with its OWN key but claims a victim's id.
	const victim = toHex(generateKeyPair().publicKey);
	const forged = makeCeremonyAuth(generateKeyPair().privateKey).stamp({ d: "round1", session: "s", from: victim, pkg: { $u8: "abcd" } });
	assert.ok(!verifyCeremony(forged), "a message claiming someone else's id is rejected");
});

test("an auth-enabled DKG + signing runs end to end with real-pubkey committee ids", async () => {
	// committee ids ARE producer pubkeys; each node's auth signs with the matching key
	const kps = [keyPairFromSeed(new Uint8Array(32).fill(1)), keyPairFromSeed(new Uint8Array(32).fill(2)), keyPairFromSeed(new Uint8Array(32).fill(3))];
	const ids = kps.map((k) => toHex(k.publicKey));
	const auth = Object.fromEntries(ids.map((id, i) => [id, makeCeremonyAuth(kps[i].privateKey)]));

	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);

	const dkg = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund", selfId: id, participants: ids, min: 2, auth: auth[id] }));
	const starts = dkg.map((c) => c.start());
	await net.idle();
	const keys = await Promise.all(starts);
	const groupPubKey = keys[0].groupPubKey;
	for (const k of keys) assert.equal(Buffer.compare(k.groupPubKey, groupPubKey), 0, "all agree on the key despite signed messages");

	// a 2-of-3 quorum co-signs, also authenticated
	const quorum = [ids[0], ids[1]];
	const sighash = sha256("authenticated withdrawal");
	const signers = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "wd", selfId: id, quorum, pub: keys[0].pub, share: keys[ids.indexOf(id)].share, message: sighash, auth: auth[id] }));
	const ss = signers.map((s) => s.start());
	await net.idle();
	const [sig] = await Promise.all(ss);
	assert.equal(verify(sig, sighash, groupPubKey), true, "authenticated ceremony still produces a valid signature");
	assert.equal(verifyWithdrawal(sig, sighash, taprootOutputKey(groupPubKey)), true, "Bitcoin accepts it");
});
