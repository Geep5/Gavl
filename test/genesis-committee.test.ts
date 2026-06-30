/**
 * Hardcoded genesis committee (testnet/dev) — deterministic, every node derives the byte-identical
 * committee from the network seed, and any threshold quorum produces a valid signature for the group key.
 *
 *   node --test test/genesis-committee.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import { deriveGenesisCommittee, genesisCommitteeMember } from "../src/custody/genesis-committee.ts";
import { thresholdSign, verify } from "../src/custody/threshold.ts";
import type { Share } from "../src/custody/threshold.ts";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

test("committee is deterministic per network + all seats agree on one group key", () => {
	const a = deriveGenesisCommittee("BTC-USD::test");
	const b = deriveGenesisCommittee("BTC-USD::test");
	assert.equal(a.length, 3);
	assert.equal(a[0].min, 2); // 2-of-3
	assert.equal(hex(a[0].groupPubKey), hex(b[0].groupPubKey), "same group key across runs");
	assert.deepEqual(a.map((m) => m.selfId), b.map((m) => m.selfId), "same member ids across runs");
	assert.ok(a.every((m) => hex(m.groupPubKey) === hex(a[0].groupPubKey)), "every seat derives the same group key");
	assert.ok(a.every((m) => JSON.stringify(m.pub) === JSON.stringify(a[0].pub)), "every seat stores the canonical pub");
});

test("different networks → different committees", () => {
	assert.notEqual(hex(deriveGenesisCommittee("net-A")[0].groupPubKey), hex(deriveGenesisCommittee("net-B")[0].groupPubKey));
});

test("any 2-of-3 quorum threshold-signs the group key", () => {
	const c = deriveGenesisCommittee("BTC-USD::test");
	const msg = new TextEncoder().encode("attestation-digest");
	for (const [i, j] of [[0, 1], [0, 2], [1, 2]] as const) {
		// keyed by the FROST identifier (derive(memberId)) — exactly what sign-coordinator uses
		const quorum: Record<string, Share> = {};
		quorum[FROST.Identifier.derive(c[i].selfId)] = c[i].share;
		quorum[FROST.Identifier.derive(c[j].selfId)] = c[j].share;
		assert.ok(verify(thresholdSign(msg, c[0].pub, quorum), msg, c[0].groupPubKey), `quorum (${i},${j}) signs`);
	}
});

test("genesisCommitteeMember selects this node's seat by index + rejects out of range", () => {
	const net = "BTC-USD::test";
	const all = deriveGenesisCommittee(net);
	assert.equal(genesisCommitteeMember(net, 0).selfId, all[0].selfId);
	assert.equal(genesisCommitteeMember(net, 2).selfId, all[2].selfId);
	assert.throws(() => genesisCommitteeMember(net, 3), /out of range/);
	assert.throws(() => genesisCommitteeMember(net, -1), /out of range/);
});
