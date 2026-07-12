/**
 * Distributed DKG over the LIVE node transport (gate #2, increment #1) —
 * independent GavlNodes run the ceremony over their gossip connections (the same
 * send/onMessage path the real I2P mesh uses), each ending with only its own
 * share, agreeing on the group key, and a quorum signing a real Bitcoin spend.
 *
 *   node --test test/custody-dkg-mesh.test.ts
 *
 * MemoryNetwork JSON-serializes every message (mimicking the wire), so a pass also
 * proves the JSON-safe encoding of FROST's binary survives the transport.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { thresholdSign, verify } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { fundAddress, taprootOutputKey, signWithdrawal, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { PARAMS } from "./helpers.ts";

function fullMesh(ids: string[]) {
	const net = new MemoryNetwork();
	const nodes: Record<string, GavlNode> = {};
	for (const id of ids) nodes[id] = new GavlNode(new Ledger(PARAMS));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	return { net, nodes };
}

test("3 nodes run DKG over the mesh — each holds its own share, all agree on the key", async () => {
	const ids = ["A", "B", "C"];
	const { net, nodes } = fullMesh(ids);
	const coords = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund-1", selfId: id, participants: ids, min: 2 }));
	const starts = coords.map((c) => c.start());
	await net.idle();
	const results = await Promise.all(starts);

	// every node computed the SAME group key from messages over the wire
	const key0 = Buffer.from(results[0].groupPubKey).toString("hex");
	for (const r of results) assert.equal(Buffer.from(r.groupPubKey).toString("hex"), key0, "all nodes agree on the group key");
	// each node holds a DISTINCT share (its own) — no node has the whole key
	const shares = results.map((r) => Buffer.from(r.share.signingShare).toString("hex"));
	assert.equal(new Set(shares).size, 3, "three distinct per-node shares");
});

test("a quorum of the mesh-generated shares threshold-signs a Bitcoin-valid spend", async () => {
	const ids = ["alice", "bob", "carol", "dave", "erin"];
	const { net, nodes } = fullMesh(ids);
	const coords = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund-2", selfId: id, participants: ids, min: 3 }));
	const starts = coords.map((c) => c.start());
	await net.idle();
	const results = await Promise.all(starts);

	// Gather a 3-of-5 quorum's shares (in production these never leave their nodes;
	// gathered here only to verify the ceremony's output). FROST identifiers come
	// from the coordinator's derive(participantId) — reconstruct the keys.
	const { schnorr_FROST } = await import("@noble/curves/secp256k1.js");
	const fidOf = (id: string) => schnorr_FROST.Identifier.derive(id);
	const groupPubKey = results[0].groupPubKey;
	const pub = results[0].pub;
	const quorumIds = ["alice", "bob", "carol"];
	const shares: Record<string, (typeof results)[number]["share"]> = {};
	for (const id of quorumIds) shares[fidOf(id)] = results[ids.indexOf(id)].share;

	const fund = { groupPubKey, pub, shares, min: 3, max: 5 } as FundKey;
	const addr = fundAddress(fund, "mainnet");
	assert.ok(addr.startsWith("bc1p"), "real P2TR address from the mesh-generated key");

	const sh = sha256(new TextEncoder().encode("withdraw from a mesh-generated fund"));
	const sig = signWithdrawal(pub, shares, sh);
	assert.equal(verify(sig, sh, groupPubKey), true, "3-of-5 quorum signs");
	assert.equal(verifyWithdrawal(sig, sh, taprootOutputKey(groupPubKey)), true, "Bitcoin accepts the spend");
});
