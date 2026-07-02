/**
 * Gavl Rounds through the FOLD — the 1-click bull/bear parimutuel primitive. Entries escrow into
 * height-derived rounds (top-N-by-stake admission); the strike and close are set by the first
 * confidence-OK oracle write at/after their boundaries (in fold order → deterministic); winners
 * split the losing pool pro-rata — ALL of it (pure parimutuel, no rake; only integer-division dust
 * goes to the liquidity pot); every edge (tie, one-sided, no-strike, oracle-dark) refunds. Oracle writes here are REAL signed-quorum updates
 * relayed on-chain (the Pyth path shares the code after verification; its conf gate is unit-tested
 * pure since guardian signatures can't be forged in a test).
 *
 *   node --test test/rounds.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, gbtcOf, marketConserved } from "../src/market/btc.ts";
import { viewRoot } from "../src/market/state.ts";
import { ROUND_LEN, ROUND_DARK_TIMEOUT, confOk, applyRoundEnter, roundsOnOracle, emptyRounds } from "../src/market/rounds.ts";
import { emptyBridge, addGbtc, gbtcOf as bGbtc } from "../src/custody/bridge.ts";
import { signReading, buildSignedUpdate, signerSetHash } from "../src/market/signed-feed.ts";
import type { SignerSet } from "../src/market/signed-feed.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K, withGbtc } from "./helpers.ts";

// Round 0 geometry (ROUND_LEN = 15): entries born < 14 (cutoff), lock = 15, close = 30.
const LOCK = ROUND_LEN;
const CLOSE = 2 * ROUND_LEN;

/** Harness: a node, funded accounts, a 2-of-3 signed oracle set, and a relayer for updates. */
function harness() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const mk = () => new Account({ node, params: PARAMS, k: K, now, keypair: generateKeyPair() });
	const members = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
	const set: SignerSet = { threshold: 2, signers: members.map((m) => toHex(m.publicKey)) };
	const oracle = { kind: "signed" as const, signerSet: signerSetHash(set) };
	/** Relay a quorum-signed price on-chain via `acct` (publishTime must increase per update). */
	const report = (acct: Account, price: bigint, publishTime: number) => {
		const sigBy: Record<string, string> = {};
		for (const m of members.slice(0, 2)) sigBy[toHex(m.publicKey)] = signReading(price, 0, publishTime, m.privateKey);
		return acct.reportMarketUpdate(JSON.stringify(buildSignedUpdate(price, 0, publishTime, set, sigBy)));
	};
	const balances: Record<string, bigint> = {};
	const fund = (a: Account, amt: bigint) => (balances[a.pubHex] = amt);
	const fold = (bornAt: Map<string, number>, nowHeight: number, extra: object = {}) =>
		computeView(node.ledger.allWrites(), { bornAt, nowHeight, market: oracle, base: withGbtc(computeView([]), balances), ...extra });
	return { node, mk, report, fund, fold, oracle, balances };
}
const born = (node: GavlNode, at: [string, number][]) => {
	const m = new Map(node.ledger.allWrites().map((w) => [w.id, 0] as [string, number]));
	for (const [id, h] of at) m.set(id, h);
	return m;
};

/** A fold base whose liquidity pot holds `pot` (backed 1:1 by reserves so marketConserved holds) —
 *  the finalized-pot input the per-fold POT-SEEDING budget (base pot / 10) derives from. */
const potBase = (balances: Record<string, bigint>, pot: bigint) => {
	const base = withGbtc(computeView([]), balances);
	base.bridge.pot += pot;
	base.bridge.reserves += pot;
	return base;
};

test("entries escrow into the round's pools; wrong-round and cutoff-anchor entries are clean no-ops", async () => {
	const { node, mk, fund, fold } = harness();
	const A = mk(), B = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const b = await B.enterRound(0, "down", 3_000n);
	const wrongIdx = await A.enterRound(1, "up", 1_000n); // says round 1, certified in round 0's window
	const late = await B.enterRound(0, "down", 1_000n); // certified in the cutoff anchor

	const v = fold(born(node, [[a, 2], [b, 3], [wrongIdx, 4], [late, LOCK - 1]]), 5);
	const r = v.rounds.get(0)!;
	assert.equal(r.poolUp, 4_000n, "up pool = A's stake");
	assert.equal(r.poolDown, 3_000n, "down pool = B's stake (cutoff entry rejected)");
	assert.equal(gbtcOf(v, A.pubHex), 6_000n, "A escrowed 4000 (wrong-idx entry was a no-op)");
	assert.equal(gbtcOf(v, B.pubHex), 7_000n, "B escrowed 3000 (late entry was a no-op)");
	assert.equal(r.strike, null, "not locked yet");
	assert.ok(marketConserved(v), "pools are a conservation bucket");
});

test("top-N-by-stake admission: a bigger stake evicts the floor (refunded); an equal one keeps the incumbent", async () => {
	const { node, mk, fund, fold } = harness();
	const A = mk(), B = mk(), C = mk(), D = mk();
	for (const x of [A, B, C, D]) fund(x, 10_000n);
	const a = await A.enterRound(0, "up", 2_000n);
	const b = await B.enterRound(0, "down", 3_000n);
	const c = await C.enterRound(0, "up", 2_500n); // full (cap 2) → evicts floor A (2000)
	const d = await D.enterRound(0, "up", 2_500n); // ties the new floor C (2500) → rejected

	const v = fold(born(node, [[a, 2], [b, 3], [c, 4], [d, 5]]), 6, { maxRoundEntries: 2 });
	const r = v.rounds.get(0)!;
	assert.equal(r.entries.size, 2, "capped at 2");
	assert.ok(!r.entries.has(A.pubHex), "floor A evicted");
	assert.ok(r.entries.has(C.pubHex), "C took the slot by out-staking");
	assert.equal(gbtcOf(v, A.pubHex), 10_000n, "A made whole (refund)");
	assert.equal(gbtcOf(v, D.pubHex), 10_000n, "D rejected on the tie — incumbent wins, nothing charged");
	assert.equal(r.poolUp, 2_500n, "up pool reflects the eviction (2000 out, 2500 in)");
	assert.ok(marketConserved(v));
});

test("re-entries MERGE (same side) and a side switch is rejected", async () => {
	const { node, mk, fund, fold } = harness();
	const A = mk();
	fund(A, 10_000n);
	const a1 = await A.enterRound(0, "up", 2_000n);
	const a2 = await A.enterRound(0, "up", 500n); // top-up (below MIN is fine on a merge)
	const a3 = await A.enterRound(0, "down", 3_000n); // side switch → no-op

	const v = fold(born(node, [[a1, 2], [a2, 3], [a3, 4]]), 5);
	const r = v.rounds.get(0)!;
	assert.equal(r.entries.get(A.pubHex)?.stake, 2_500n, "merged to one slot");
	assert.equal(r.poolUp, 2_500n);
	assert.equal(r.poolDown, 0n, "side switch rejected");
	assert.equal(gbtcOf(v, A.pubHex), 7_500n);
	assert.ok(marketConserved(v));
});

test("full lifecycle: strike at lock, close one window later — winners split the WHOLE losing pool, round deletes", async () => {
	const { node, mk, report, fund, fold } = harness();
	const A = mk(), B = mk(), R = mk(); // R = the (untrusted) oracle relayer
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const b = await B.enterRound(0, "down", 6_000n);
	const strike = await report(R, 100_000n, 1_000); // first update ≥ lock → strike
	const close = await report(R, 101_000n, 2_000); // first update ≥ close → up wins

	const v = fold(born(node, [[a, 2], [b, 3], [strike.id, LOCK], [close.id, CLOSE]]), CLOSE + 1);
	assert.equal(v.rounds.size, 0, "round settled and deleted itself");
	// losePool 6000 → dist 6000 (pure parimutuel, no rake); A is the whole win pool → share 6000, dust 0.
	assert.equal(gbtcOf(v, A.pubHex), 10_000n - 4_000n + 4_000n + 6_000n, "A: stake back + the WHOLE losing pool");
	assert.equal(gbtcOf(v, B.pubHex), 4_000n, "B lost its stake");
	assert.equal(v.bridge.pot, 0n, "no rake — nothing to the pot (dust 0)");
	assert.ok(marketConserved(v), "conserved end to end");
});

test("tie and one-sided rounds refund everyone", async () => {
	const { node, mk, report, fund, fold } = harness();
	const A = mk(), B = mk(), R = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	// tie: both sides entered, close == strike
	const a = await A.enterRound(0, "up", 4_000n);
	const b = await B.enterRound(0, "down", 6_000n);
	const s1 = await report(R, 100_000n, 1_000);
	const c1 = await report(R, 100_000n, 2_000); // close == strike → tie
	const v1 = fold(born(node, [[a, 2], [b, 3], [s1.id, LOCK], [c1.id, CLOSE]]), CLOSE + 1);
	assert.equal(v1.rounds.size, 0);
	assert.equal(gbtcOf(v1, A.pubHex), 10_000n, "tie → A refunded");
	assert.equal(gbtcOf(v1, B.pubHex), 10_000n, "tie → B refunded");
	assert.equal(v1.bridge.pot, 0n, "nothing to the pot on a refund");
	assert.ok(marketConserved(v1));

	// one-sided: only UP entries; even though up "wins", there's no losing pool → refund
	const { node: n2, mk: mk2, report: rp2, fund: f2, fold: fold2 } = harness();
	const C = mk2(), R2 = mk2();
	f2(C, 10_000n);
	const c = await C.enterRound(0, "up", 4_000n);
	const s2 = await rp2(R2, 100_000n, 1_000);
	const c2 = await rp2(R2, 105_000n, 2_000);
	const v2 = fold2(born(n2, [[c, 2], [s2.id, LOCK], [c2.id, CLOSE]]), CLOSE + 1);
	assert.equal(gbtcOf(v2, C.pubHex), 10_000n, "one-sided → refunded");
	assert.ok(marketConserved(v2));
});

test("no strike by the close boundary → refund; oracle dark past the timeout → the sweep refunds at the deadline", async () => {
	// no strike: the FIRST oracle write lands after the close boundary
	const { node, mk, report, fund, fold } = harness();
	const A = mk(), B = mk(), R = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const b = await B.enterRound(0, "down", 6_000n);
	const lateUpdate = await report(R, 100_000n, 1_000);
	const v = fold(born(node, [[a, 2], [b, 3], [lateUpdate.id, CLOSE + 2]]), CLOSE + 3);
	assert.equal(v.rounds.size, 0, "never struck → refunded on the first post-close write");
	assert.equal(gbtcOf(v, A.pubHex), 10_000n);
	assert.equal(gbtcOf(v, B.pubHex), 10_000n);
	assert.ok(marketConserved(v));

	// oracle fully dark: NO update ever → the end-of-fold sweep refunds once past close + timeout
	const { node: n2, mk: mk2, fund: f2, fold: fold2 } = harness();
	const C = mk2(), D = mk2();
	f2(C, 10_000n);
	f2(D, 10_000n);
	const c = await C.enterRound(0, "up", 4_000n);
	const d = await D.enterRound(0, "down", 6_000n);
	const bornMap = born(n2, [[c, 2], [d, 3]]);
	const before = fold2(bornMap, CLOSE + ROUND_DARK_TIMEOUT - 1);
	assert.equal(before.rounds.size, 1, "still waiting one anchor before the deadline");
	const after = fold2(bornMap, CLOSE + ROUND_DARK_TIMEOUT);
	assert.equal(after.rounds.size, 0, "dark timeout → swept");
	assert.equal(gbtcOf(after, C.pubHex), 10_000n);
	assert.equal(gbtcOf(after, D.pubHex), 10_000n);
	assert.ok(marketConserved(after));
});

test("confidence gate (pure): a wide-conf update neither strikes nor settles; the next tight one does", () => {
	assert.ok(confOk(100_000n, 0n), "conf 0 (signed feeds) always passes");
	assert.ok(confOk(100_000n, 500n), "exactly 50 bps passes");
	assert.ok(!confOk(100_000n, 501n), "wider than 50 bps fails");

	const bridge = emptyBridge();
	addGbtc(bridge, "aa", 10_000n);
	addGbtc(bridge, "bb", 10_000n);
	bridge.reserves = 20_000n;
	const rounds = emptyRounds();
	assert.ok(applyRoundEnter(bridge, rounds, "aa", 0, "up", 4_000n, 2));
	assert.ok(applyRoundEnter(bridge, rounds, "bb", 0, "down", 6_000n, 3));
	// wide-conf update at the lock boundary → skipped (no strike)
	roundsOnOracle(bridge, rounds, 100_000n, 501n, LOCK);
	assert.equal(rounds.get(0)!.strike, null, "blurry photo skipped");
	// tight update one anchor later → strike
	roundsOnOracle(bridge, rounds, 100_100n, 100n, LOCK + 1);
	assert.equal(rounds.get(0)!.strike, 100_100n, "next clear update strikes");
	// wide at close → skipped; tight one settles (up wins: 100_200 > 100_100)
	roundsOnOracle(bridge, rounds, 100_200n, 1_000n, CLOSE);
	assert.equal(rounds.size, 1, "blurry close skipped");
	const toPot = roundsOnOracle(bridge, rounds, 100_200n, 0n, CLOSE + 1);
	assert.equal(rounds.size, 0, "settled");
	assert.equal(toPot, 0n, "no rake — dust 0 on this settle");
	assert.equal(bGbtc(bridge, "aa"), 10_000n + 6_000n, "aa won the whole 6000 losing pool");
});

// ── POT-SEEDING: at lock the pot stakes the thin side, capped at 10% of the FOLD-BASE pot ──

test("pot-seeding at lock: the thin side is seeded to balance, capped at 10% of the BASE pot", async () => {
	// big pot: a one-sided round (only UP) gets its whole imbalance seeded — totals balance
	const { node, mk, report, fund, fold, balances } = harness();
	const A = mk(), R = mk();
	fund(A, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const strike = await report(R, 100_000n, 1_000);
	const v = fold(born(node, [[a, 2], [strike.id, LOCK]]), LOCK + 1, { base: potBase(balances, 100_000n) });
	const r = v.rounds.get(0)!;
	assert.equal(r.strike, 100_000n, "locked");
	assert.equal(r.seedDown, 4_000n, "need 4000 ≤ budget 10000 → fully balanced");
	assert.equal(r.seedUp, 0n);
	assert.equal(r.poolUp + r.seedUp, r.poolDown + r.seedDown, "a fully-seeded round has equal totals");
	assert.equal(v.bridge.pot, 100_000n - 4_000n, "the pot dropped by exactly the seed");
	assert.ok(marketConserved(v), "the seed is escrow, not a leak");

	// small pot: the same round only draws pot/10
	const h2 = harness();
	const C = h2.mk(), R2 = h2.mk();
	h2.fund(C, 10_000n);
	const c = await C.enterRound(0, "up", 4_000n);
	const s2 = await h2.report(R2, 100_000n, 1_000);
	const v2 = h2.fold(born(h2.node, [[c, 2], [s2.id, LOCK]]), LOCK + 1, { base: potBase(h2.balances, 5_000n) });
	assert.equal(v2.rounds.get(0)!.seedDown, 500n, "capped at 10% of the base pot (5000/10)");
	assert.equal(v2.bridge.pot, 5_000n - 500n);
	assert.ok(marketConserved(v2));
});

test("seeded side LOSES: winners split ALL of loseStakes+seed; the pot nets −seed (+ dust)", async () => {
	const { node, mk, report, fund, fold, balances } = harness();
	const A = mk(), B = mk(), R = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n); // up-heavy: 4000 vs 1000 → need 3000
	const b = await B.enterRound(0, "down", 1_000n);
	const strike = await report(R, 100_000n, 1_000); // lock → seedDown = 3000 (budget 10000)
	const close = await report(R, 101_000n, 2_000); // up wins → the seeded side lost
	const v = fold(born(node, [[a, 2], [b, 3], [strike.id, LOCK], [close.id, CLOSE]]), CLOSE + 1, { base: potBase(balances, 100_000n) });
	assert.equal(v.rounds.size, 0, "settled and deleted");
	// loseTotal = 1000 stakes + 3000 seed = 4000 → dist 4000 (no rake); A is the whole win total
	// (winTotal 4000) → share 4000·4000/4000 = 4000, dust 0. A: 6000 free + 4000 stake + 4000.
	assert.equal(gbtcOf(v, A.pubHex), 6_000n + 4_000n + 4_000n, "A won the WHOLE seed-fattened losing total");
	assert.equal(gbtcOf(v, B.pubHex), 9_000n, "B lost its stake");
	// pot's net for the round = dust 0 − seed 3000: 100000 − 3000 = 97000.
	assert.equal(v.bridge.pot, 100_000n - 3_000n, "the pot paid the seed; nothing comes back on a loss");
	assert.ok(marketConserved(v));
});

test("seeded side WINS: the pot takes its seed back plus a stake-like pro-rata share", async () => {
	const { node, mk, report, fund, fold, balances } = harness();
	const A = mk(), B = mk(), R = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n); // up-heavy again → seedDown = 3000 at lock
	const b = await B.enterRound(0, "down", 1_000n);
	const strike = await report(R, 100_000n, 1_000);
	const close = await report(R, 99_000n, 2_000); // down wins → the pot's seed rode the winner
	const v = fold(born(node, [[a, 2], [b, 3], [strike.id, LOCK], [close.id, CLOSE]]), CLOSE + 1, { base: potBase(balances, 100_000n) });
	assert.equal(v.rounds.size, 0);
	// winTotal = 1000 (B) + 3000 (seed) = 4000; loseTotal = 4000 → dist 4000 (no rake).
	// B: stake + 1000·4000/4000 = 2000. Pot: seed 3000 + 3000·4000/4000 = 3000 + dust 0.
	assert.equal(gbtcOf(v, B.pubHex), 9_000n + 1_000n + 1_000n, "B's entry earns on its stake only");
	assert.equal(gbtcOf(v, A.pubHex), 6_000n, "A lost its stake");
	assert.equal(v.bridge.pot, 100_000n - 3_000n + 3_000n + 3_000n, "seed home + winnings");
	assert.ok(v.bridge.pot > 100_000n, "the pot GREW on a winning seed");
	assert.ok(marketConserved(v));
});

test("refund path returns the seed: the dark sweep restores the pot to its pre-seed value", async () => {
	const { node, mk, report, fund, fold, balances } = harness();
	const A = mk(), R = mk();
	fund(A, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const strike = await report(R, 100_000n, 1_000); // lock seeds down 4000 — then the oracle goes dark
	const bornMap = born(node, [[a, 2], [strike.id, LOCK]]);
	const before = fold(bornMap, CLOSE + ROUND_DARK_TIMEOUT - 1, { base: potBase(balances, 100_000n) });
	assert.equal(before.rounds.get(0)!.seedDown, 4_000n, "seeded and still live before the deadline");
	assert.ok(marketConserved(before));
	const after = fold(bornMap, CLOSE + ROUND_DARK_TIMEOUT, { base: potBase(balances, 100_000n) });
	assert.equal(after.rounds.size, 0, "dark timeout → swept");
	assert.equal(gbtcOf(after, A.pubHex), 10_000n, "the entry was refunded");
	assert.equal(after.bridge.pot, 100_000n, "the pot got its seed back — restored exactly");
	assert.ok(marketConserved(after));
});

test("pot-seeding determinism: full fold vs checkpoint-resumed fold agree byte-for-byte", async () => {
	const { node, mk, report, fund, oracle, balances } = harness();
	const A = mk(), B = mk(), R = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const b = await B.enterRound(0, "down", 1_000n);
	const strike = await report(R, 100_000n, 1_000); // lock → seeds 3000 down
	const close = await report(R, 101_000n, 2_000); // up wins over the seeded side
	const all = node.ledger.allWrites();
	const heights = new Map([[a, 2], [b, 3], [strike.id, LOCK], [close.id, CLOSE]]);
	const bornOf = (ws: typeof all) => new Map(ws.map((w) => [w.id, heights.get(w.id) ?? 0]));

	// The budget derives from each fold's BASE pot, so equivalence needs the snapshot pot to equal
	// the full fold's base pot — arranged here by snapshotting AFTER the entries but BEFORE the
	// strike, with nothing (no settles, no demurrage) touching the pot in between.
	const POT = 50_000n;
	const full = computeView(all, { bornAt: bornOf(all), nowHeight: CLOSE + 1, market: oracle, base: potBase(balances, POT) });
	const half = all.filter((w) => w.id !== strike.id && w.id !== close.id); // entries only
	const snapshot = computeView(half, { bornAt: bornOf(half), nowHeight: 5, market: oracle, base: potBase(balances, POT) });
	assert.equal(snapshot.bridge.pot, POT, "nothing touched the pot before the strike → same budget");
	const resumed = computeView(all.filter((w) => w.id === strike.id || w.id === close.id), { bornAt: bornOf(all), nowHeight: CLOSE + 1, market: oracle, base: snapshot });

	assert.equal(viewRoot(resumed), viewRoot(full), "seeded full fold and checkpoint-resumed fold agree byte-for-byte");
	assert.equal(resumed.bridge.pot, POT - 3_000n, "both paths seeded 3000; the losing seed stayed distributed (dust 0)");
	assert.ok(marketConserved(resumed));
});

test("checkpoint equivalence: resuming from a mid-round snapshot folds to the identical root", async () => {
	const { node, mk, report, fund, oracle, balances } = harness();
	const A = mk(), B = mk(), R = mk();
	fund(A, 10_000n);
	fund(B, 10_000n);
	const a = await A.enterRound(0, "up", 4_000n);
	const b = await B.enterRound(0, "down", 6_000n);
	const strike = await report(R, 100_000n, 1_000);
	const close = await report(R, 99_000n, 2_000); // down wins
	const all = node.ledger.allWrites();
	const heights = new Map([[a, 2], [b, 3], [strike.id, LOCK], [close.id, CLOSE]]);
	const bornOf = (ws: typeof all) => new Map(ws.map((w) => [w.id, heights.get(w.id) ?? 0]));

	// one full fold vs. a checkpoint mid-round (entries + strike applied) + folding just the close on top
	const full = computeView(all, { bornAt: bornOf(all), nowHeight: CLOSE + 1, market: oracle, base: withGbtc(computeView([]), balances) });
	const half = all.filter((w) => w.id !== close.id);
	const snapshot = computeView(half, { bornAt: bornOf(half), nowHeight: LOCK + 1, market: oracle, base: withGbtc(computeView([]), balances) });
	assert.equal(snapshot.rounds.get(0)?.strike, 100_000n, "the snapshot carries a LIVE locked round");
	const resumed = computeView(all.filter((w) => w.id === close.id), { bornAt: bornOf(all), nowHeight: CLOSE + 1, market: oracle, base: snapshot });

	assert.equal(viewRoot(resumed), viewRoot(full), "full fold and checkpoint-resumed fold agree byte-for-byte");
	assert.equal(gbtcOf(resumed, B.pubHex), 4_000n + 6_000n + 4_000n, "B: 4000 unspent + stake back + the WHOLE 4000 losing pool");
	assert.ok(marketConserved(resumed));
});
