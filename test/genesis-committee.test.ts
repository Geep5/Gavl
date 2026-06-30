/**
 * Trusted-dealer genesis committee — `mintCommittee` cuts a 2-of-3 with fresh randomness (run once, by the
 * setup script), any quorum signs, and two mints are independent (the key isn't reproducible from the repo).
 *
 *   node --test test/genesis-committee.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import { mintCommittee } from "../src/custody/genesis-committee.ts";
import { thresholdSign, verify } from "../src/custody/threshold.ts";
import type { Share } from "../src/custody/threshold.ts";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

test("mintCommittee cuts a 2-of-3 with a compressed group key + canonical pub", () => {
	const c = mintCommittee();
	assert.equal(c.members.length, 3);
	assert.equal(c.min, 2);
	assert.equal(c.participants.length, 3);
	assert.equal(c.groupPubKey.length, 33); // compressed secp256k1 point
	assert.ok(c.members.every((m) => m.share && m.secretKey.length === 32)); // each seat holds its own secret
});

test("any 2-of-3 quorum threshold-signs the group key", () => {
	const c = mintCommittee();
	const msg = new TextEncoder().encode("withdraw-digest");
	for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
		// keyed by the FROST identifier (derive(memberId)) — exactly what sign-coordinator uses
		const quorum: Record<string, Share> = {};
		quorum[FROST.Identifier.derive(c.members[i].selfId)] = c.members[i].share;
		quorum[FROST.Identifier.derive(c.members[j].selfId)] = c.members[j].share;
		assert.ok(verify(thresholdSign(msg, c.pub, quorum), msg, c.groupPubKey), `quorum (${i},${j}) signs`);
	}
});

test("each mint is fresh + random — the key is not reproducible from the repo", () => {
	assert.notEqual(hex(mintCommittee().groupPubKey), hex(mintCommittee().groupPubKey));
});
