/**
 * Generic signed price feed — the Pyth model (an M-of-N quorum) generalized to any signer set. The
 * channel commits a set by hash; an update carries the set + member signatures; the fold requires a
 * quorum of DISTINCT valid members (a tampered, sub-quorum, wrong-set, or forged update fails).
 *
 *   node --test test/signed-feed.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { signReading, buildSignedUpdate, signerSetHash, verifySignedQuorum, type SignerSet } from "../src/market/signed-feed.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";

/** A 2-of-3 set + a helper that signs a reading with the chosen member indices. */
function setup() {
	const members = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
	const set: SignerSet = { threshold: 2, signers: members.map((m) => toHex(m.publicKey)) };
	const sign = (price: bigint, expo: number, t: number, who: number[]) => {
		const sigBy: Record<string, string> = {};
		for (const i of who) sigBy[toHex(members[i].publicKey)] = signReading(price, expo, t, members[i].privateKey);
		return buildSignedUpdate(price, expo, t, set, sigBy);
	};
	return { members, set, hash: signerSetHash(set), sign };
}

test("a quorum-signed reading verifies against the committed set hash", () => {
	const { hash, sign } = setup();
	const u = sign(6_591_845_500_000n, -8, 1_718_400_000, [0, 2]); // 2-of-3

	const r = verifySignedQuorum(u, hash);
	assert.ok(r, "a 2-of-3 update verifies");
	assert.equal(r!.price, 6_591_845_500_000n);
	assert.equal(r!.expo, -8);
	assert.equal(r!.publishTime, 1_718_400_000);
});

test("a sub-quorum update fails — one signer is not enough (this is the whole point)", () => {
	const { hash, sign } = setup();
	const oneSig = sign(65_000n, -2, 1_718_400_000, [1]); // only 1 of the required 2
	assert.equal(verifySignedQuorum(oneSig, hash), null, "1-of-3 against a 2-of-3 set is rejected");
});

test("tampering, a wrong set, a weakened threshold, or garbage all fail (no one can forge)", () => {
	const { members, set, hash, sign } = setup();
	const u = sign(65_000n, -2, 1_718_400_000, [0, 1]);

	assert.equal(verifySignedQuorum({ ...u, price: "99999999" }, hash), null, "tampered price fails (sigs no longer match)");
	assert.equal(verifySignedQuorum({ ...u, publishTime: u.publishTime + 1 }, hash), null, "tampered time fails");
	assert.equal(verifySignedQuorum(u, signerSetHash({ ...set, threshold: 1 })), null, "a weaker-threshold commitment doesn't match this update's set");
	assert.equal(verifySignedQuorum({ ...u, set: { ...u.set, threshold: 1 } }, hash), null, "relayer lowering the update's own threshold changes its set hash → rejected");

	// substituting a different member key into the set changes the hash → mismatch
	const swapped = { ...u, set: { threshold: u.set.threshold, signers: [...u.set.signers.slice(0, 2), toHex(generateKeyPair().publicKey)].sort() } };
	assert.equal(verifySignedQuorum(swapped, hash), null, "swapping in a foreign key fails the set-hash check");

	assert.equal(verifySignedQuorum({ ...u, sigs: [[0, "zz"]] }, hash), null, "garbage sig fails");
	assert.equal(verifySignedQuorum(null, hash), null, "null is rejected, not thrown");

	// duplicate signatures from ONE member can't fake a quorum
	const dup = sign(65_000n, -2, 1_718_400_000, [0]);
	dup.sigs = [dup.sigs[0], [0, dup.sigs[0][1]]]; // same member twice
	assert.equal(verifySignedQuorum(dup, hash), null, "one member signing twice is still one distinct signer");

	void members;
});

test("the relayer is irrelevant — the quorum is what's checked, so anyone can post it", () => {
	const { hash, sign } = setup();
	const u = sign(65_000n, -2, 1_718_400_000, [2, 0]);
	assert.ok(verifySignedQuorum(u, hash), "the genuine quorum still verifies for any relayer");
});
