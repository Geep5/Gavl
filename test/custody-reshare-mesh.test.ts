/**
 * Committee rotation over the mesh (gate #2) — deterministic selection from the VDF
 * beacon, then a distributed reshare ceremony hands the fund key to a NEW committee
 * (each old member handling only its own share). The new committee signs for the
 * SAME group key — so the Taproot address is stable across rotations.
 *
 *   node --test test/custody-reshare-mesh.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { generateFundKeyDKG, thresholdSign, verify } from "../src/custody/threshold.ts";
import { ReshareCoordinator } from "../src/custody/reshare-coordinator.ts";
import { selectCommittee } from "../src/custody/committee.ts";
import { taprootOutputKey, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { schnorr_FROST } from "@noble/curves/secp256k1.js";
import { sha256, toHex } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

const id = (n: number) => schnorr_FROST.Identifier.fromNumber(n);

test("committee selection is deterministic from the VDF beacon (all nodes agree)", () => {
	const members = Array.from({ length: 20 }, (_, i) => ({ id: "node" + i, weight: BigInt(i + 1) }));
	const beacon = toHex(sha256("epoch-7-vdf-output"));
	const a = selectCommittee(members, beacon, 5).map((m) => m.id);
	const b = selectCommittee(members, beacon, 5).map((m) => m.id);
	assert.deepEqual(a, b, "same beacon → identical committee on every node");
	assert.equal(new Set(a).size, 5, "5 distinct seats");
	// a different beacon (next epoch) generally yields a different committee
	const c = selectCommittee(members, toHex(sha256("epoch-8-vdf-output")), 5).map((m) => m.id);
	assert.notDeepEqual(a, c, "rotation: a new beacon rotates the committee");
});

test("distributed reshare hands the fund to a NEW committee; same group key, stable address", async () => {
	// old 2-of-3 fund (in-process DKG gives the starting shares)
	const fund = generateFundKeyDKG(2, 3);
	const groupPubKey = fund.groupPubKey;
	const oldQuorum = [id(1), id(2)]; // participating old members
	const newCommittee = [id(11), id(12), id(13)]; // a fresh committee
	const newMin = 2;

	// nodes: the old quorum + the new committee, full-mesh
	const nodeIds = [...oldQuorum, ...newCommittee];
	const net = new MemoryNetwork();
	const nodes: Record<string, GavlNode> = {};
	for (const nid of nodeIds) nodes[nid] = new GavlNode(new Ledger(PARAMS));
	for (let i = 0; i < nodeIds.length; i++) for (let j = i + 1; j < nodeIds.length; j++) net.link(nodes[nodeIds[i]], nodes[nodeIds[j]]);

	const coords = nodeIds.map(
		(nid) =>
			new ReshareCoordinator(nodes[nid], {
				session: "rotate-1",
				selfId: nid,
				oldQuorum,
				newCommittee,
				newMin,
				groupPubKey,
				oldShare: oldQuorum.includes(nid) ? fund.shares[nid] : undefined,
			}),
	);
	const starts = coords.map((c) => c.start());
	await net.idle();
	const results = await Promise.all(starts);

	// new members got shares; the group key is UNCHANGED on every node
	for (const r of results) assert.equal(Buffer.compare(r.groupPubKey, groupPubKey), 0, "group key unchanged");
	const newShares: Record<string, (typeof results)[number]["share"]> = {};
	results.forEach((r, i) => {
		if (newCommittee.includes(nodeIds[i])) {
			assert.ok(r.share, "new member received a share");
			newShares[nodeIds[i]] = r.share;
		}
	});
	assert.equal(Object.keys(newShares).length, 3, "all 3 new members hold shares");

	// the NEW committee (a 2-of-3 quorum) signs for the SAME group key → stable address.
	// Every node assembled the identical new package from the broadcast verifying shares.
	const pub = results[0].pub;
	const quorum = { [id(11)]: newShares[id(11)], [id(12)]: newShares[id(12)] };
	const msg = sha256("after rotation");
	const sig = thresholdSign(msg, pub, quorum);
	assert.equal(verify(sig, msg, groupPubKey), true, "rotated committee signs for the original key");
	assert.equal(verifyWithdrawal(sig, msg, taprootOutputKey(groupPubKey)), true, "Bitcoin accepts it — address never changed");
});
