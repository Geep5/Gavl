/**
 * Committee rotation over the mesh (gate #2) — deterministic selection from the VDF
 * beacon, then a distributed reshare ceremony hands the fund key to a NEW committee
 * (each old member handling only its own share). The new committee signs for the
 * SAME group key — so the Taproot address is stable across rotations.
 *
 *   node --test test/custody-reshare-mesh.test.ts
 *
 * The fund is minted by the DISTRIBUTED DKG and the rotated committee co-signs via
 * the DISTRIBUTED signing ceremony — i.e. the exact `derive(pid)`-identifier path the
 * daemon uses, so the id↔scalar convention is exercised end to end (an earlier reshare
 * bug that mismatched it would surface here as a failed signature).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { ReshareCoordinator } from "../src/custody/reshare-coordinator.ts";
import { SignCoordinator } from "../src/custody/sign-coordinator.ts";
import { selectCommittee } from "../src/custody/committee.ts";
import { verify } from "../src/custody/threshold.ts";
import { taprootOutputKey, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { sha256, toHex } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

function fullMesh(ids: string[]) {
	const net = new MemoryNetwork();
	const nodes: Record<string, GavlNode> = {};
	for (const id of ids) nodes[id] = new GavlNode(new Ledger(PARAMS));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	return { net, nodes };
}

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

test("distributed reshare hands the fund to a NEW committee; the new committee co-signs for the SAME key", async () => {
	const oldCommittee = ["alice", "bob", "carol"]; // produced the fund via DKG
	const oldMin = 2;
	const oldQuorum = ["alice", "bob"]; // the participating old members (carol sits out — churn)
	const newCommittee = ["dave", "erin", "frank"]; // a fresh committee
	const newMin = 2;

	// every node in either committee, full-mesh
	const allIds = [...new Set([...oldCommittee, ...newCommittee])];
	const { net, nodes } = fullMesh(allIds);

	// 1) the OLD committee mints the fund via distributed DKG (derive(pid) identifiers).
	const dkg = oldCommittee.map((id) => new DkgCoordinator(nodes[id], { session: "old-fund", selfId: id, participants: oldCommittee, min: oldMin }));
	const dkgStarts = dkg.map((c) => c.start());
	await net.idle();
	const oldKeys = await Promise.all(dkgStarts);
	const groupPubKey = oldKeys[0].groupPubKey;
	const oldShareOf = Object.fromEntries(oldCommittee.map((id, i) => [id, oldKeys[i].share]));
	const origAddress = taprootOutputKey(groupPubKey);

	// 2) distributed reshare → the new committee. Only the old QUORUM participates
	//    (carol absent), each handling only its own share.
	const reshareIds = [...oldQuorum, ...newCommittee];
	const coords = reshareIds.map(
		(id) =>
			new ReshareCoordinator(nodes[id], {
				session: "rotate-1",
				selfId: id,
				oldQuorum,
				newCommittee,
				newMin,
				groupPubKey,
				oldShare: oldQuorum.includes(id) ? oldShareOf[id] : undefined,
			}),
	);
	const starts = coords.map((c) => c.start());
	await net.idle();
	const results = await Promise.all(starts);

	// the group key is UNCHANGED on every participant; new members got shares
	for (const r of results) assert.equal(Buffer.compare(r.groupPubKey, groupPubKey), 0, "group key unchanged");
	const newShareOf: Record<string, NonNullable<(typeof results)[number]["share"]>> = {};
	results.forEach((r, i) => {
		if (newCommittee.includes(reshareIds[i])) {
			assert.ok(r.share, "new member received a share");
			newShareOf[reshareIds[i]] = r.share;
		}
	});
	assert.equal(Object.keys(newShareOf).length, 3, "all 3 new members hold shares");
	const pub = results[reshareIds.indexOf("dave")].pub; // identical on every node

	// 3) the NEW committee (a 2-of-3 quorum) co-signs over the mesh for the SAME group
	//    key — via the distributed signing ceremony, share never gathered.
	const quorum = ["dave", "erin"];
	const sighash = sha256("after rotation");
	const signers = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "post-rotate", selfId: id, quorum, pub, share: newShareOf[id], message: sighash }));
	const signStarts = signers.map((s) => s.start());
	await net.idle();
	const sigs = await Promise.all(signStarts);

	for (const sig of sigs) {
		assert.equal(verify(sig, sighash, groupPubKey), true, "rotated committee signs for the original key");
		assert.equal(verifyWithdrawal(sig, sighash, origAddress), true, "Bitcoin accepts it — the address never changed");
	}
	assert.equal(Buffer.compare(sigs[0], sigs[1]), 0, "both new signers produced the identical signature");
});
