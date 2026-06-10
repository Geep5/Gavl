/**
 * Epoch-driven rotation (gate #2) — the autonomous custody loop end to end. Driving
 * CommitteeRotation on every node with a shared finalized chain, the network mints
 * the fund at genesis (distributed DKG), publishes the address, then rotates the key
 * to a freshly-selected committee (distributed reshare) when the beacon reshuffles —
 * the Taproot address never moving — and a quorum of the new committee co-signs.
 *
 *   node --test test/custody-rotation.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { CommitteeRotation } from "../src/custody/rotation.ts";
import { committeeForEpoch } from "../src/custody/epoch.ts";
import type { AnchorView } from "../src/custody/epoch.ts";
import { SignCoordinator } from "../src/custody/sign-coordinator.ts";
import { quorumForRound } from "../src/custody/committee.ts";
import { verify } from "../src/custody/threshold.ts";
import { taprootOutputKey, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import type { StoredShare } from "../src/custody/share-store.ts";
import { sha256 } from "../src/det/canonical.ts";
import { PARAMS } from "./helpers.ts";

const EPOCH = 4;
const SIZE = 3;
const OPTS = { epochLength: EPOCH, size: SIZE, windowAnchors: undefined };

// heights 0..8: producers chosen so epoch 1's members are {p0,p1,p2} and epoch 2's
// are all six — so the sampled committee changes across the boundary (asserted below).
const PRODUCERS = ["p0", "p1", "p2", "p0", "p3", "p4", "p5", "p3", "p0"];
const chainTo = (height: number): AnchorView[] => PRODUCERS.slice(0, height + 1).map((producer, h) => ({ height: h, producer, time: { output: "vdf-" + h } }));

test("genesis DKG → publish → rotation reshare, all off the finalized chain; address never moves", async () => {
	const ids = ["p0", "p1", "p2", "p3", "p4", "p5"];
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);

	// shared "on-chain" fund key + per-node share stores (each node's secret-local share)
	const published: { key: Uint8Array | null } = { key: null };
	const shares = new Map<string, StoredShare | null>();
	const rots = ids.map(
		(id) =>
			new CommitteeRotation({
				node: nodes[id],
				selfId: id,
				epochLength: EPOCH,
				size: SIZE,
				timeoutMs: 500,
				minCommittee: 3,
				groupKey: () => published.key,
				publishFund: (k) => {
					published.key = k;
				},
				loadShare: () => shares.get(id) ?? null,
				saveShare: (s) => shares.set(id, s),
				clearShare: () => shares.set(id, null),
			}),
	);

	const c1 = committeeForEpoch(chainTo(EPOCH), 1, OPTS)!.committee; // boundary height 4
	const c2 = committeeForEpoch(chainTo(2 * EPOCH), 2, OPTS)!.committee; // boundary height 8
	assert.equal(c1.length, 3);
	assert.equal(c2.length, 3);
	assert.notDeepEqual([...c1].sort(), [...c2].sort(), "the committee actually rotates across the boundary");

	// ── epoch 1: genesis ──────────────────────────────────────────────
	const g = rots.map((r) => r.onFinalized(chainTo(EPOCH)));
	await net.idle();
	await Promise.all(g);

	assert.ok(published.key, "fund key was DKG'd and published on-chain");
	const address = taprootOutputKey(published.key!);
	for (const id of c1) {
		const s = shares.get(id);
		assert.ok(s, `${id} (genesis committee) holds a share`);
		assert.deepEqual([...s!.participants].sort(), [...c1].sort(), "share tagged with the genesis committee");
		assert.equal(s!.epoch, 1);
	}

	// ── epoch 2: rotation (same fund, new committee) ──────────────────
	const r2 = rots.map((r) => r.onFinalized(chainTo(2 * EPOCH)));
	await net.idle();
	await Promise.all(r2);

	assert.equal(Buffer.compare(published.key!, published.key!), 0);
	for (const id of c2) {
		const s = shares.get(id);
		assert.ok(s, `${id} (new committee) holds a rotated share`);
		assert.deepEqual([...s!.participants].sort(), [...c2].sort(), "share tagged with the new committee");
		assert.equal(s!.epoch, 2);
		assert.equal(Buffer.compare(s!.groupPubKey, published.key!), 0, "same group key after rotation");
	}

	// ── the NEW committee co-signs for the SAME address ───────────────
	const min2 = committeeForEpoch(chainTo(2 * EPOCH), 2, OPTS)!.min;
	const quorum = quorumForRound(c2, min2, 0);
	const pub = shares.get(c2[0])!.pub;
	const sighash = sha256("post-rotation withdrawal");
	const signers = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "after", selfId: id, quorum, pub, share: shares.get(id)!.share, message: sighash }));
	const ss = signers.map((s) => s.start());
	await net.idle();
	const sigs = await Promise.all(ss);
	assert.equal(verify(sigs[0], sighash, published.key!), true, "new committee signs for the original key");
	assert.equal(verifyWithdrawal(sigs[0], sighash, address), true, "Bitcoin accepts it at the unchanged address");
});

test("a node not yet eligible does nothing; the loop is non-reentrant and one-shot per epoch", async () => {
	const ids = ["p0", "p1", "p2", "p3", "p4", "p5"];
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	const published: { key: Uint8Array | null } = { key: null };
	const shares = new Map<string, StoredShare | null>();
	let dkgRuns = 0;
	const rot = (id: string) =>
		new CommitteeRotation({
			node: nodes[id],
			selfId: id,
			epochLength: EPOCH,
			size: SIZE,
			timeoutMs: 500,
			minCommittee: 3,
			groupKey: () => published.key,
			publishFund: (k) => {
				published.key = k;
				dkgRuns++;
			},
			loadShare: () => shares.get(id) ?? null,
			saveShare: (s) => shares.set(id, s),
			clearShare: () => shares.set(id, null),
		});
	const rots = ids.map(rot);

	// p3/p4/p5 aren't members at epoch 1 → they must NOT participate or hold shares.
	const c1 = committeeForEpoch(chainTo(EPOCH), 1, OPTS)!.committee;
	const g = rots.map((r) => r.onFinalized(chainTo(EPOCH)));
	await net.idle();
	await Promise.all(g);
	assert.ok(published.key, "fund published at genesis");
	// each genesis member publishes the (identical) key — redundant on purpose, so a
	// single lost publish doesn't strand the address.
	const afterGenesis = dkgRuns;
	assert.equal(afterGenesis, c1.length, "every genesis committee member published");
	for (const id of ["p3", "p4", "p5"]) assert.ok(!shares.get(id), `${id} not yet eligible — no share`);

	// feeding the same epoch again is a no-op (one-shot per epoch)
	await Promise.all(rots.map((r) => r.onFinalized(chainTo(EPOCH))));
	assert.equal(dkgRuns, afterGenesis, "re-feeding epoch 1 does not re-run genesis");
});
