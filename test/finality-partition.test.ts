/**
 * Sticky finality vs. partitions — a split must heal at the default settings, unless it outlived
 * SETTLEMENT.
 *
 * Sticky finality locks the tip's d-th ancestor. A node that keeps mining while it can't hear
 * the rest of the network (a partition, or simply anchors outrunning gossip) locks ITS OWN branch;
 * the other side locks a sibling at the same height. Before the fork-resolution rule both sides
 * rejected the other's branch as "conflicts with finalized history" forever — a permanent split.
 *
 * Now a conflicting branch is weighed against the lock: whichever branch was built EXCLUSIVELY by a
 * weighted majority of the producers active before the fork (pre-fork window, anchors won) is
 * final; if neither is, the heavier branch wins. Every node with the same anchors computes the
 * same answer, so a healed partition converges — while a minority's heavier private branch still
 * can't revert what an honest majority finalized.
 *
 * SETTLEMENT (DEFAULT_SETTLEMENT_DEPTH) is absolute: a branch that abandons a node's settled anchor
 * is refused whatever resolveFork says, and reported — irreversible actions (BTC payouts, share
 * deletion) already happened on it, so a permanent loud split beats un-backed coins.
 *
 *   node --test test/finality-partition.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../src/det/ed25519.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { AnchorChain, DEFAULT_FINALITY_DEPTH, DEFAULT_SETTLEMENT_DEPTH } from "../src/consensus/chain.ts";
import { genesisAnchor } from "../src/consensus/genesis.ts";
import { Producer } from "../src/consensus/producer.ts";
import { PARAMS, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const GENESIS = genesisAnchor({ network: "finality-partition", difficulty: PARAMS.difficulty, appRoot: "" });

interface Farmer {
	node: GavlNode;
	producer: Producer;
}

function farmer(): Farmer {
	const node = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: DEFAULT_FINALITY_DEPTH, settlementDepth: DEFAULT_SETTLEMENT_DEPTH }));
	node.anchors!.installGenesis(GENESIS);
	const keypair = generateKeyPair();
	const producer = new Producer({ node, keypair, prover: standinProver(keypair), params: PARAMS });
	return { node, producer };
}

/** Mine exactly one anchor on the farmer's current tip (a stand-in plot can miss a challenge). */
async function mine(f: Farmer): Promise<void> {
	for (let i = 0; i < 50; i++) if (await f.producer.produceOne()) return;
	throw new Error("no proof in 50 challenges");
}

/** Fully mesh `fs` on `net`; returns the per-pair unlink functions keyed "i-j". */
function mesh(net: MemoryNetwork, fs: Farmer[]): Map<string, () => void> {
	const links = new Map<string, () => void>();
	for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) links.set(`${i}-${j}`, net.link(fs[i].node, fs[j].node));
	return links;
}

/** `rounds` rounds of every farmer in `side` mining one anchor, gossip drained between. */
async function farm(net: MemoryNetwork, side: Farmer[], rounds: number): Promise<void> {
	for (let r = 0; r < rounds; r++)
		for (const f of side) {
			await mine(f);
			await net.idle();
		}
}

const tipOf = (f: Farmer) => f.node.anchorTip()!.id;
const lockedOf = (f: Farmer) => f.node.anchors!.finalized(DEFAULT_FINALITY_DEPTH)!;

test("2-vs-2 partition shallower than settlement: each side locks its own branch; after healing all four converge", async () => {
	const fs = [farmer(), farmer(), farmer(), farmer()];
	const net = new MemoryNetwork();
	const links = mesh(net, fs);
	await farm(net, fs, 2); // shared prefix: every producer has anchors in the pre-fork window
	const prefixTip = tipOf(fs[0]);
	assert.ok(fs.every((f) => tipOf(f) === prefixTip), "one chain before the partition");

	for (const k of ["0-2", "0-3", "1-2", "1-3"]) links.get(k)!(); // {0,1} | {2,3}
	await farm(net, [fs[0], fs[1]], 3);
	await farm(net, [fs[2], fs[3]], 3);
	const lockA = lockedOf(fs[0]);
	const lockC = lockedOf(fs[2]);
	assert.notEqual(lockA.id, lockC.id, "each side finalized a different branch");
	assert.ok(lockA.height > fs[0].node.anchors!.get(prefixTip)!.height && lockC.height > fs[0].node.anchors!.get(prefixTip)!.height, "both locks are above the fork point");

	net.link(fs[0].node, fs[2].node); // heal
	net.link(fs[1].node, fs[3].node);
	await net.idle();
	const healed = tipOf(fs[0]);
	assert.ok(fs.every((f) => tipOf(f) === healed), "all four nodes converged on one tip after the heal");

	await farm(net, fs, 1); // and they keep building ONE chain
	const after = tipOf(fs[0]);
	assert.ok(fs.every((f) => tipOf(f) === after), "still one chain after more farming");
	assert.ok(fs.every((f) => lockedOf(f).id === lockedOf(fs[0]).id), "and one finalized anchor");
});

test("a minority's heavier private branch cannot revert what the majority finalized; the minority rejoins", async () => {
	const fs = [farmer(), farmer(), farmer(), farmer()];
	const [a, b, c, e] = fs; // e = minority (one anchor in the pre-fork window vs. the majority's six)
	const net = new MemoryNetwork();
	const links = mesh(net, fs);
	await farm(net, [a, b, c], 2);
	await farm(net, [e], 1);
	for (const k of ["0-3", "1-3", "2-3"]) links.get(k)!(); // isolate e
	await farm(net, [a, b, c], 1); // the majority finalizes its branch
	const honestTip = tipOf(a);
	await farm(net, [e], DEFAULT_SETTLEMENT_DEPTH - 1); // e grinds a longer (heavier) private branch — not yet settled
	assert.ok(BigInt(e.node.anchorTip()!.weight) > BigInt(a.node.anchorTip()!.weight), "the private branch IS heavier");

	net.link(a.node, e.node); // release it
	await net.idle();
	assert.equal(tipOf(a), honestTip, "the majority keeps its finalized branch despite the heavier fork");
	assert.equal(tipOf(b), honestTip);
	assert.equal(tipOf(e), honestTip, "the minority node adopts the majority-final branch");
});

test("a split DEEPER than settlement is refused (and flagged) by the side it would revert — never silently reverted", async () => {
	const fs = [farmer(), farmer(), farmer(), farmer()];
	const net = new MemoryNetwork();
	const links = mesh(net, fs);
	await farm(net, fs, 2);
	for (const k of ["0-2", "0-3", "1-2", "1-3"]) links.get(k)!(); // {0,1} | {2,3}
	await farm(net, [fs[0], fs[1]], DEFAULT_SETTLEMENT_DEPTH); // 2·S anchors per side → each SETTLES its own branch
	await farm(net, [fs[2], fs[3]], DEFAULT_SETTLEMENT_DEPTH);
	const settledA = fs[0].node.anchors!.settled()!;
	const settledC = fs[2].node.anchors!.settled()!;
	assert.notEqual(settledA.id, settledC.id, "each side settled a different branch");
	const tipA = tipOf(fs[0]);
	const tipC = tipOf(fs[2]);

	net.link(fs[0].node, fs[2].node); // heal
	net.link(fs[1].node, fs[3].node);
	await net.idle();
	assert.equal(fs[0].node.anchors!.settled()!.id, settledA.id, "settled history never moves");
	assert.equal(fs[2].node.anchors!.settled()!.id, settledC.id);
	assert.ok(tipOf(fs[0]) === tipA || tipOf(fs[2]) === tipC, "at least the side whose branch lost resolveFork refused it");
	assert.notEqual(tipOf(fs[0]), tipOf(fs[2]), "the split stays (a permanent split beats un-backed coins)");
	const flagged = fs.filter((f) => f.node.anchors!.settledConflict !== null);
	assert.ok(flagged.length >= 2, "the refusing side reports the settlement conflict");
	for (const f of flagged) assert.equal(f.node.anchors!.settledConflict!.settled.id, f.node.anchors!.settled()!.id, "the flag names the node's own settled anchor");
});

test("a split from genesis (no pre-fork producers) heals to the heavier branch", async () => {
	const x = farmer();
	const y = farmer();
	const net = new MemoryNetwork();
	await farm(net, [x], 3); // never linked: two independent runs from the shared block 0
	await farm(net, [y], 4);
	assert.notEqual(lockedOf(x).id, lockedOf(y).id, "each locked its own run");
	net.link(x.node, y.node);
	await net.idle();
	assert.equal(tipOf(x), tipOf(y), "converged");
});
