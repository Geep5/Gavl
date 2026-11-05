/**
 * Epoch-driven rotation (gate #2) — the autonomous custody loop end to end. Driving
 * CommitteeRotation on every node with a shared finalized chain, the network mints
 * the fund at genesis (distributed DKG), publishes the address + first holder, then
 * reshares the key from the RECORDED holder to a freshly-selected committee, which
 * records the handoff on-chain (group-key-signed) — the Taproot address never moving.
 * A failed reshare records nothing, so the next epoch retries from the real holders.
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
import { sha256, toHex } from "../src/det/canonical.ts";
import { PARAMS, CustodyLedger } from "./helpers.ts";

const EPOCH = 4;
const SIZE = 3;
const OPTS = { epochLength: EPOCH, size: SIZE, windowAnchors: undefined };
const CUSTODY = { epochLength: EPOCH, size: SIZE, windowAnchors: 2 * EPOCH, minCommittee: 3, genesisSize: SIZE };

// heights 0..12: producers chosen so epoch 1's members are {p0,p1,p2} and later epochs draw from
// all six — so the sampled committee changes across boundaries (asserted below).
const PRODUCERS = ["p0", "p1", "p2", "p0", "p3", "p4", "p5", "p3", "p0", "p1", "p4", "p5", "p2"];
const chainTo = (height: number): AnchorView[] => PRODUCERS.slice(0, height + 1).map((producer, h) => ({ height: h, producer, time: { output: "vdf-" + h } }));
const IDS = ["p0", "p1", "p2", "p3", "p4", "p5"];

function network(timeoutMs = 500) {
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(IDS.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++) net.link(nodes[IDS[i]], nodes[IDS[j]]);
	const ledger = new CustodyLedger(chainTo, CUSTODY);
	const rots = Object.fromEntries(IDS.map((id) => [id, new CommitteeRotation({ node: nodes[id], selfId: id, params: CUSTODY, timeoutMs, ...ledger.hooks(id) })]));
	/** Finalize up to `height` on the given nodes (the rest are "offline" this epoch). The epoch's
	 *  records land just after its boundary. */
	const advance = async (height: number, online = IDS) => {
		ledger.height = height + 1;
		const runs = online.map((id) => rots[id].onFinalized(chainTo(height)));
		await net.idle();
		await Promise.all(runs);
	};
	return { net, nodes, ledger, advance };
}

test("genesis DKG → publish → reshare from the recorded holder → handoff recorded; address never moves", async () => {
	const { net, nodes, ledger, advance } = network();
	const c1 = committeeForEpoch(chainTo(EPOCH), 1, OPTS)!.committee; // boundary height 4
	const c2 = committeeForEpoch(chainTo(2 * EPOCH), 2, OPTS)!; // boundary height 8
	assert.equal(c1.length, 3);
	assert.equal(c2.committee.length, 3);
	assert.notDeepEqual([...c1].sort(), [...c2.committee].sort(), "the committee actually rotates across the boundary");

	// ── epoch 1: genesis ──────────────────────────────────────────────
	await advance(EPOCH);
	const custody = ledger.custody();
	assert.ok(custody.fundKey, "fund key was DKG'd and published on-chain");
	assert.deepEqual(custody.holder?.committee, [...c1].sort(), "the genesis committee is the first recorded holder");
	assert.equal(custody.holder?.epoch, 1);
	const groupKey = custody.fundKey!;
	const address = taprootOutputKey(Buffer.from(groupKey, "hex"));
	for (const id of c1) assert.equal(ledger.share(id, 1)?.epoch, 1, `${id} (genesis committee) holds an epoch-1 share`);

	// ── epoch 2: reshare to the new committee, which records the handoff ──
	await advance(2 * EPOCH);
	const after = ledger.custody();
	assert.equal(after.fundKey, groupKey, "same fund key");
	assert.equal(after.holder?.epoch, 2, "the handoff advanced the recorded holder");
	assert.deepEqual(after.holder?.committee, [...c2.committee].sort());
	assert.equal(after.prevHolder?.epoch, 1, "the genesis holder is kept as prevHolder");
	for (const id of c2.committee) assert.equal(toHex(ledger.share(id, 2)!.groupPubKey), groupKey, `${id} holds an epoch-2 share of the SAME key`);

	// ── the NEW committee co-signs for the SAME address ───────────────
	const quorum = quorumForRound(c2.committee, c2.min, 0);
	const pub = ledger.share(c2.committee[0], 2)!.pub;
	const sighash = sha256("post-rotation withdrawal");
	const ss = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "after", selfId: id, quorum, pub, share: ledger.share(id, 2)!.share, message: sighash }).start());
	await net.idle();
	const sigs = await Promise.all(ss);
	assert.equal(verify(sigs[0], sighash, Buffer.from(groupKey, "hex")), true, "new committee signs for the original key");
	assert.equal(verifyWithdrawal(sigs[0], sighash, address), true, "Bitcoin accepts it at the unchanged address");
});

test("a reshare that times out records nothing; the NEXT epoch reshares from the recorded holder (no wedge)", async () => {
	const { ledger, advance } = network(300);
	const c1 = committeeForEpoch(chainTo(EPOCH), 1, OPTS)!.committee;
	const c2 = committeeForEpoch(chainTo(2 * EPOCH), 2, OPTS)!.committee;
	const c3 = committeeForEpoch(chainTo(3 * EPOCH), 3, OPTS)!.committee;
	assert.notDeepEqual([...c2].sort(), [...c1].sort(), "epoch 2's sample is NOT the holder — the old rule would look for shares nobody has");

	await advance(EPOCH); // genesis
	const groupKey = ledger.custody().fundKey!;

	// epoch 2: every genesis holder is offline → the incoming members can't form an old quorum
	await advance(2 * EPOCH, c2.filter((id) => !c1.includes(id)));
	assert.equal(ledger.custody().holder?.epoch, 1, "failed reshare → the genesis committee is still the recorded holder");
	for (const id of c1) assert.ok(ledger.share(id, 1), `${id} still has its epoch-1 share`);

	// epoch 3: everyone online → the reshare runs from the RECORDED holder (epoch 1), not epoch 2's sample
	await advance(3 * EPOCH);
	const custody = ledger.custody();
	assert.equal(custody.holder?.epoch, 3, "epoch 3's handoff recorded");
	assert.deepEqual(custody.holder?.committee, [...c3].sort());
	assert.equal(custody.fundKey, groupKey, "group key unchanged");
	for (const id of c3) assert.equal(toHex(ledger.share(id, 3)!.groupPubKey), groupKey, `${id} holds an epoch-3 share of the same key`);
});

test("a node not yet eligible does nothing; the loop is non-reentrant and one-shot per epoch", async () => {
	const { ledger, advance } = network();
	const c1 = committeeForEpoch(chainTo(EPOCH), 1, OPTS)!.committee;
	await advance(EPOCH);
	assert.ok(ledger.custody().fundKey, "fund published at genesis");
	for (const id of ["p3", "p4", "p5"]) assert.equal(ledger.shares.get(id), undefined, `${id} not yet eligible — no share`);
	const shares = c1.map((id) => ledger.share(id, 1)!.share);

	// feeding the same epoch again is a no-op (one-shot per epoch): the genesis shares are untouched
	await advance(EPOCH);
	assert.deepEqual(c1.map((id) => ledger.share(id, 1)!.share), shares, "re-feeding epoch 1 does not re-run genesis");
});
