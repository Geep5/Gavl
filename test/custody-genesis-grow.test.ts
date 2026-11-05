/**
 * Genesis liveness (option B) — genesis DKG runs among a SMALL committee, then the first
 * reshare GROWS it to the full target size, keeping the same group key / address.
 *
 * DKG is n-of-n for generation (any dropout aborts), so a large genesis committee rarely
 * completes across real independent nodes. Genesis among a small set (genesisSize) is likely
 * all-online; the committee then grows to `size` via the normal reshare. Because every node
 * derives the per-epoch committee size from the on-chain genesis epoch (fundEpoch), genesis and
 * the grow-reshare agree on who holds the key with no special-casing.
 *
 *   node --test test/custody-genesis-grow.test.ts
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
import { sha256 } from "../src/det/canonical.ts";
import { PARAMS, CustodyLedger } from "./helpers.ts";

const EPOCH = 4;
const GENESIS_SIZE = 3;
const TARGET_SIZE = 5;

// h0..3 → {p0,p1,p2} (3 eligible → genesis among 3); h0..7 → {p0..p6} (7 eligible → grow to 5).
const PRODUCERS = ["p0", "p1", "p2", "p0", "p3", "p4", "p5", "p6", "p0"];
const chainTo = (height: number): AnchorView[] => PRODUCERS.slice(0, height + 1).map((producer, h) => ({ height: h, producer, time: { output: "vdf-" + h } }));

test("genesis runs among a small committee, then the first reshare grows it to the full size (same address)", async () => {
	const ids = ["p0", "p1", "p2", "p3", "p4", "p5", "p6"];
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);

	const custody = { epochLength: EPOCH, size: TARGET_SIZE, windowAnchors: 2 * EPOCH, minCommittee: GENESIS_SIZE, genesisSize: GENESIS_SIZE };
	const ledger = new CustodyLedger(chainTo, custody);
	const rots = ids.map(
		(id) =>
			new CommitteeRotation({
				node: nodes[id],
				selfId: id,
				params: custody,
				timeoutMs: 500,
				...ledger.hooks(id), // fundEpoch (the on-chain genesis epoch) drives the size schedule
			}),
	);
	const advance = async (height: number) => {
		ledger.height = height + 1;
		const runs = rots.map((r) => r.onFinalized(chainTo(height)));
		await net.idle();
		await Promise.all(runs);
	};

	// the deterministic committees: genesis is size-3, the grown one is size-5.
	const genesis = committeeForEpoch(chainTo(EPOCH), 1, { epochLength: EPOCH, size: GENESIS_SIZE })!.committee;
	const grown = committeeForEpoch(chainTo(2 * EPOCH), 2, { epochLength: EPOCH, size: TARGET_SIZE })!.committee;
	assert.equal(genesis.length, 3, "genesis committee is small (n-of-n-able)");
	assert.equal(grown.length, 5, "the grown committee is the full target size");

	// ── epoch 1: genesis DKG among the SMALL committee ────────────────
	await advance(EPOCH);
	const fund = ledger.custody();
	assert.ok(fund.fundKey, "fund key DKG'd + published");
	assert.equal(fund.epoch, 1, "genesis epoch recorded on-chain");
	assert.equal(fund.holder?.min, 2, "genesis threshold is 2-of-3");
	const groupKey = Buffer.from(fund.fundKey!, "hex");
	const address = taprootOutputKey(groupKey);
	for (const id of genesis) {
		const s = ledger.share(id, 1);
		assert.ok(s, `${id} (genesis) holds a share`);
		assert.deepEqual([...s!.participants].sort(), [...genesis].sort(), "tagged with the small genesis committee");
	}

	// ── epoch 2: the first reshare GROWS the committee to the full size ──
	await advance(2 * EPOCH);
	const holder = ledger.custody().holder!;
	assert.deepEqual(holder.committee, [...grown].sort(), "the grown committee recorded the handoff");
	assert.equal(holder.min, 4, "grown threshold is 4-of-5");
	for (const id of grown) {
		const s = ledger.share(id, 2);
		assert.ok(s, `${id} (grown committee) holds a rotated share`);
		assert.equal(Buffer.compare(s!.groupPubKey, groupKey), 0, "SAME group key after growing");
	}

	// ── the grown committee co-signs for the unchanged address ────────
	const quorum = quorumForRound(grown, 4, 0);
	const pub = ledger.share(grown[0], 2)!.pub;
	const sighash = sha256("post-growth withdrawal");
	const signers = quorum.map((id) => new SignCoordinator(nodes[id], { signId: "grown", selfId: id, quorum, pub, share: ledger.share(id, 2)!.share, message: sighash }));
	const ss = signers.map((s) => s.start());
	await net.idle();
	const sigs = await Promise.all(ss);
	assert.equal(verify(sigs[0], sighash, groupKey), true, "the grown 4-of-5 signs for the original key");
	assert.equal(verifyWithdrawal(sigs[0], sighash, address), true, "Bitcoin accepts it at the unchanged address");
});
