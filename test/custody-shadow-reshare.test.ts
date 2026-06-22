/**
 * Shadow reshare coordinator (verifiable encrypted resharing, phase 2 shadow run) over the mesh.
 *
 *   node --test test/custody-shadow-reshare.test.ts
 *
 * Old-quorum members broadcast contribution deals; every node assembles the blob; old members verify it
 * publicly and new members combine a valid share — all in-process here, the same path the daemon runs
 * live alongside the real ceremony. The coordinator is validation-only: it writes no share + no store.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { ShadowReshareCoordinator } from "../src/custody/shadow-reshare.ts";
import { assembleReshare } from "../src/custody/reshare-blob.ts";
import { deriveEncKey } from "../src/custody/enckey.ts";
import * as ed from "../src/det/ed25519.ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { mod, randScalar, SECP256K1_N as N } from "../src/custody/shamir.ts";
import { fidScalar } from "../src/custody/committee.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

const G = secp256k1.Point.BASE;
const ev = (coeffs: bigint[], xj: bigint): bigint => {
	let y = 0n;
	let xp = 1n;
	for (const a of coeffs) {
		y = mod(y + a * xp, N);
		xp = mod(xp * xj, N);
	}
	return y;
};

function fullMesh(ids: string[]) {
	const net = new MemoryNetwork();
	const nodes: Record<string, GavlNode> = {};
	for (const id of ids) nodes[id] = new GavlNode(new Ledger(PARAMS));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	return { net, nodes };
}

test("shadow run: old quorum's deals assemble into a blob that verifies + new members combine valid shares", async () => {
	const secret = randScalar();
	const poly = [secret, randScalar()]; // degree 1: {A,B} (oldMin 2) reconstruct `secret`

	const old = { A: ed.generateKeyPair(), B: ed.generateKeyPair() };
	const next = { D: ed.generateKeyPair(), E: ed.generateKeyPair(), F: ed.generateKeyPair() };
	const idOf = Object.fromEntries(Object.entries({ ...old, ...next }).map(([n, k]) => [n, toHex(k.publicKey)]));
	const oldQuorum = [idOf.A, idOf.B];
	const newCommittee = [idOf.D, idOf.E, idOf.F];
	const groupKey = G.multiply(secret).toBytes(true);

	// old shares + their public verifying shares; new members' encryption keys (the registry's view)
	const oldShare = { [idOf.A]: ev(poly, fidScalar(idOf.A)), [idOf.B]: ev(poly, fidScalar(idOf.B)) };
	const vsOf: Record<string, Uint8Array> = { [idOf.A]: G.multiply(oldShare[idOf.A]).toBytes(true), [idOf.B]: G.multiply(oldShare[idOf.B]).toBytes(true) };
	const encOf: Record<string, Uint8Array> = { [idOf.D]: deriveEncKey(next.D.privateKey).publicKey, [idOf.E]: deriveEncKey(next.E.privateKey).publicKey, [idOf.F]: deriveEncKey(next.F.privateKey).publicKey };
	const encKeyOf = (id: string) => encOf[id];

	const { net, nodes } = fullMesh([...oldQuorum, ...newCommittee]);
	const base = { epoch: 7, oldQuorum, newCommittee, newMin: 2, groupKey, encKeyOf, timeoutMs: 4000 };

	const coords: Record<string, ShadowReshareCoordinator> = {
		[idOf.A]: new ShadowReshareCoordinator({ node: nodes[idOf.A], selfId: idOf.A, myOldShare: oldShare[idOf.A], oldVerifyingShareOf: (id) => vsOf[id], ...base }),
		[idOf.B]: new ShadowReshareCoordinator({ node: nodes[idOf.B], selfId: idOf.B, myOldShare: oldShare[idOf.B], oldVerifyingShareOf: (id) => vsOf[id], ...base }),
		[idOf.D]: new ShadowReshareCoordinator({ node: nodes[idOf.D], selfId: idOf.D, myEncKey: deriveEncKey(next.D.privateKey), ...base }),
		[idOf.E]: new ShadowReshareCoordinator({ node: nodes[idOf.E], selfId: idOf.E, myEncKey: deriveEncKey(next.E.privateKey), ...base }),
		[idOf.F]: new ShadowReshareCoordinator({ node: nodes[idOf.F], selfId: idOf.F, myEncKey: deriveEncKey(next.F.privateKey), ...base }),
	};
	for (const id of Object.keys(coords)) nodes[id].onShadowDeal = (epoch, deal) => coords[id].onDeal(epoch, deal);

	const starts = Object.values(coords).map((c) => c.start());
	await net.idle();
	const results = await Promise.all(starts);
	const byId = Object.fromEntries(Object.keys(coords).map((id, i) => [id, results[i]]));

	for (const r of results) assert.equal(r.complete, true, "every node assembled the full quorum's deals");

	// old members built their deals + the assembled blob verifies publicly
	for (const id of oldQuorum) {
		assert.equal(byId[id].built, true, "old-quorum member built + broadcast its contribution");
		assert.equal(byId[id].blobVerifies, true, "blob verifies: honest contributions + fund key preserved");
	}
	// new members recover a valid share from the blob (Feldman passes for every deal)
	for (const id of newCommittee) assert.equal(byId[id].combineOk, true, `new member ${id.slice(0, 8)} combined a valid share`);

	// the CUTOVER consumes the coordinator's assembled blob: a new member turns it into a usable FROST
	// reshare result for the SAME fund key (this is exactly what the daemon's reshareViaBlob saves).
	const dBlob = byId[newCommittee[0]].blob;
	assert.ok(dBlob, "the coordinator exposes the assembled blob for the cutover to consume");
	const consumed = assembleReshare(dBlob, newCommittee[0], deriveEncKey(next.D.privateKey));
	assert.equal(toHex(consumed.groupPubKey), toHex(groupKey), "the consumed share is for the SAME fund key");
});
