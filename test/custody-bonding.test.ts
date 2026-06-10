/**
 * Committee bonding (gate #3) — a node locks gBTC as a bond to be eligible for the
 * custody committee; the bond is its SELECTION WEIGHT and is slashable. This proves
 * the fold (lock/unlock, conservation) and that selection becomes STAKE-weighted.
 *
 *   node --test test/custody-bonding.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { bridgeKeyPair } from "../src/market/oracle.ts";
import { bondedTotal } from "../src/custody/bridge.ts";
import { committeeForEpoch } from "../src/custody/epoch.ts";
import type { AnchorView } from "../src/custody/epoch.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const acct = (kp?: ReturnType<typeof bridgeKeyPair>) => new Account({ node, params: PARAMS, k: K, now, keypair: kp });
	return { node, acct };
}
const view = (node: GavlNode) => computeView(node.ledger.allWrites());

test("bond locks free gBTC (still backed); unbond releases it; can't over-bond", async () => {
	const { node, acct } = setup();
	const me = acct();
	await acct(bridgeKeyPair()).attestDeposit("d:0", me.pubHex, 10_000n); // seed-mint 10k to me
	assert.equal(gbtcOf(view(node), me.pubHex), 10_000n);

	await me.bond(6000n);
	assert.equal(gbtcOf(view(node), me.pubHex), 4000n, "bonded gBTC leaves the free balance");
	assert.equal(view(node).bridge.bonds.get(me.pubHex), 6000n, "…and is held as a bond");
	assert.equal(bondedTotal(view(node).bridge), 6000n);
	assert.ok(marketConserved(view(node)), "bonded gBTC is still 1:1-backed (conservation holds)");

	// can't bond more than the free balance
	await me.bond(99_999n);
	assert.equal(view(node).bridge.bonds.get(me.pubHex), 6000n, "over-bond rejected");

	await me.unbond(2000n);
	assert.equal(gbtcOf(view(node), me.pubHex), 6000n, "unbonded gBTC returns to free");
	assert.equal(view(node).bridge.bonds.get(me.pubHex), 4000n);
	assert.ok(marketConserved(view(node)));

	// bonded gBTC is locked: a withdrawal can't spend it (only the 6k free covers it)
	await me.withdraw(7000n, "tb1qexamplexxxxxxxxxxxxxxxxxxxxxxxxxxxx");
	assert.equal(view(node).bridge.pending.length, 0, "can't withdraw more than the FREE balance");
	await me.withdraw(6000n, "tb1qexamplexxxxxxxxxxxxxxxxxxxxxxxxxxxx");
	assert.equal(view(node).bridge.pending.length, 1, "free balance withdraws fine");
});

// a chain where heights 0..15 are produced by p0..p4 round-robin → all 5 are eligible
const chain = (n: number): AnchorView[] => Array.from({ length: n }, (_, h) => ({ height: h, producer: "p" + (h % 5), time: { output: "vdf-" + h } }));

test("selection is stake-weighted when bonds are given: only bonded producers, weighted by bond", () => {
	const c = chain(20); // boundary for epoch 1 (epochLength 8) is height 8; producers p0..p4
	const opts = { epochLength: 8, size: 3 };

	// no bonds → anchor-count weighting (all 5 producers eligible)
	const noBond = committeeForEpoch(c, 1, opts)!;
	assert.equal(new Set(noBond.members.map((m) => m.id)).size, 5, "all producers eligible without bonding");

	// with bonds → only bonded producers, weight = bond. p3/p4 unbonded → ineligible.
	const bonds = new Map<string, bigint>([
		["p0", 100n],
		["p1", 50n],
		["p2", 10n],
	]);
	const bonded = committeeForEpoch(c, 1, { ...opts, bonds })!;
	assert.deepEqual(
		bonded.members.map((m) => m.id).sort(),
		["p0", "p1", "p2"],
		"only bonded producers are eligible",
	);
	assert.equal(bonded.members.find((m) => m.id === "p0")!.weight, 100n, "weight is the bond, not anchor count");
	assert.equal(bonded.committee.length, 3, "committee fills from the bonded set");
	// a producer that farms but never bonds can't be selected
	assert.ok(!bonded.committee.includes("p4"), "unbonded farmer excluded from the committee");
});

test("more bond → more seats over many epochs (stake-weighted, deterministic)", () => {
	// p0 bonds 100x the others; across 12 epochs it should win far more seats.
	const c = chain(8 * 14);
	const bonds = new Map<string, bigint>([
		["p0", 10_000n],
		["p1", 100n],
		["p2", 100n],
		["p3", 100n],
		["p4", 100n],
	]);
	let p0Seats = 0;
	for (let e = 1; e <= 12; e++) {
		const cm = committeeForEpoch(c, e, { epochLength: 8, size: 2, bonds });
		if (cm?.committee.includes("p0")) p0Seats++;
	}
	assert.ok(p0Seats >= 10, `the heavy-bonded producer wins most seats (got ${p0Seats}/12)`);
});
