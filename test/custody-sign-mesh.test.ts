/**
 * Distributed SIGNING over the mesh (gate #2, increment #2) — a quorum co-signs a
 * Bitcoin withdrawal with each node using ONLY its own share; the shares are never
 * gathered into one place. Combined with distributed DKG, the fund key and every
 * share never meet — true threshold custody end to end.
 *
 *   node --test test/custody-sign-mesh.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { SignCoordinator } from "../src/custody/sign-coordinator.ts";
import { verify } from "../src/custody/threshold.ts";
import { taprootOutputKey, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { PARAMS } from "./helpers.ts";

function fullMesh(ids: string[]) {
	const net = new MemoryNetwork();
	const nodes: Record<string, GavlNode> = {};
	for (const id of ids) nodes[id] = new GavlNode(new Ledger(PARAMS));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	return { net, nodes };
}

test("a quorum co-signs a withdrawal over the mesh — shares never gathered", async () => {
	const ids = ["alice", "bob", "carol", "dave", "erin"];
	const { net, nodes } = fullMesh(ids);

	// 1) distributed DKG — each node ends with only its own share
	const dkg = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund", selfId: id, participants: ids, min: 3 }));
	const dkgStarts = dkg.map((c) => c.start());
	await net.idle();
	const keys = await Promise.all(dkgStarts);
	const groupPubKey = keys[0].groupPubKey;
	const pub = keys[0].pub;

	// 2) a 3-of-5 quorum co-signs a sighash — each SignCoordinator gets only ITS node's
	//    share (note: shares from `keys[i].share`, never combined into one structure)
	const quorum = ["alice", "bob", "carol"];
	const sighash = sha256(new TextEncoder().encode("withdraw 0.1 BTC to a user"));
	const signers = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "wd-1", selfId: id, quorum, pub, share: keys[ids.indexOf(id)].share, message: sighash }));
	const signStarts = signers.map((s) => s.start());
	await net.idle();
	const sigs = await Promise.all(signStarts);

	// every signer aggregated the SAME valid signature
	for (const sig of sigs) {
		assert.equal(sig.length, 64, "64-byte Schnorr signature");
		assert.equal(verify(sig, sighash, groupPubKey), true, "valid against the group key");
		assert.equal(verifyWithdrawal(sig, sighash, taprootOutputKey(groupPubKey)), true, "Bitcoin accepts the distributed-signed spend");
	}
	assert.equal(Buffer.compare(sigs[0], sigs[1]), 0, "all signers produced the identical signature");
});

test("a different quorum of the same fund also co-signs validly", async () => {
	const ids = ["n1", "n2", "n3", "n4"];
	const { net, nodes } = fullMesh(ids);
	const dkg = ids.map((id) => new DkgCoordinator(nodes[id], { session: "f", selfId: id, participants: ids, min: 2 }));
	const ds = dkg.map((c) => c.start());
	await net.idle();
	const keys = await Promise.all(ds);
	const sighash = sha256(new TextEncoder().encode("payout"));

	const quorum = ["n3", "n4"]; // a different pair than {n1,n2}
	const signers = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "w", selfId: id, quorum, pub: keys[0].pub, share: keys[ids.indexOf(id)].share, message: sighash }));
	const ss = signers.map((s) => s.start());
	await net.idle();
	const [sig] = await Promise.all(ss);
	assert.equal(verifyWithdrawal(sig, sighash, taprootOutputKey(keys[0].groupPubKey)), true, "any quorum can co-sign");
});
