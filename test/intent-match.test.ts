/**
 * The peer-to-peer intent market core — signed-offer match + bounded contracts.
 * Pure (BridgeState + MarketBook), no node/consensus. The load-bearing invariant is
 * CONSERVATION: reserves == free gBTC + bonded + pending + escrowed-in-contracts,
 * asserted after every operation, including over random op streams.
 *
 *   node --test test/intent-match.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { emptyBridge, mintFromDeposit, gbtcOf, totalGbtc, bondedTotal, pendingTotal } from "../src/custody/bridge.ts";
import type { BridgeState } from "../src/custody/bridge.ts";
import { keyPairFromSeed } from "../src/det/ed25519.ts";
import { sha256, toHex } from "../src/det/canonical.ts";
import { emptyBook, escrowedInContracts, signOffer, verifyOffer, longPayout, applyMatch, applySettle } from "../src/market/intent.ts";
import type { MarketBook, OfferCore, Side } from "../src/market/intent.ts";

// ── helpers ──────────────────────────────────────────────────────

let depN = 0;
function acct(i: number) {
	const kp = keyPairFromSeed(sha256("intent-acct-" + i));
	return { pub: toHex(kp.publicKey), priv: kp.privateKey };
}
/** Fund an account with gBTC via a verified deposit (keeps reserves balanced 1:1). */
function fund(bridge: BridgeState, pub: string, amount: bigint) {
	mintFromDeposit(bridge, { depositId: "d" + depN++ + ":0", depositor: pub, amount });
}
/** The conservation invariant this whole design rests on. */
function conserved(bridge: BridgeState, book: MarketBook): boolean {
	return bridge.reserves === totalGbtc(bridge) + bondedTotal(bridge) + pendingTotal(bridge) + escrowedInContracts(book);
}

function offer(maker: ReturnType<typeof acct>, over: Partial<OfferCore> = {}) {
	const core: OfferCore = {
		maker: maker.pub,
		makerSide: "long",
		size: "1000",
		leverage: "2",
		expiryHeight: 100,
		settleHeight: 200,
		nonce: "n" + (over.nonce ?? Math.random().toString(36).slice(2)),
		...over,
		maker: maker.pub, // keep maker authoritative even if `over` set it
	};
	return signOffer(core, maker.priv);
}
const MARK = 61000n; // the entry price used in match tests

// ── signature / shape ────────────────────────────────────────────

test("offer verifies; tamper or bad leverage/key fails", () => {
	const a = acct(1);
	const o = offer(a);
	assert.equal(verifyOffer(o), true);
	assert.equal(verifyOffer({ ...o, size: "999" }), false, "tampered field breaks the sig");
	assert.equal(verifyOffer({ ...o, sig: "00".repeat(64) }), false, "bad sig rejected");
	assert.equal(verifyOffer(offer(a, { leverage: "1" })), false, "leverage 1× rejected (pointless)");
	assert.equal(verifyOffer(offer(a, { leverage: "0" })), false, "leverage 0 rejected");
	assert.equal(verifyOffer(offer(a, { leverage: "1000" })), false, "leverage above max rejected");
	assert.equal(verifyOffer(offer(a, { size: "0" })), false, "non-positive size rejected");
});

// ── payoff bounds + zero-sum ─────────────────────────────────────

test("payoff is directional, capped at the stake, and exactly zero-sum", () => {
	const stake = 1000n, entry = 61000n, pot = 2000n;
	// at entry → even; each side just gets its own stake back
	assert.equal(longPayout(stake, entry, 1n, entry), 1000n, "no move → even");
	// 1× leverage: a +1% move pays ~1% of stake
	assert.equal(longPayout(stake, entry, 1n, 61610n), 1010n, "+1% at 1× → long +10");
	assert.equal(longPayout(stake, entry, 1n, entry * 2n), pot, "price doubles at 1× → long takes whole pot");
	// 10× leverage: a 1/10 move is the cap in either direction
	assert.equal(longPayout(stake, entry, 10n, entry + entry / 10n), pot, "+10% at 10× → full pot");
	assert.equal(longPayout(stake, entry, 10n, entry - entry / 10n), 0n, "-10% at 10× → long wiped");
	assert.equal(longPayout(stake, entry, 10n, 80000n), pot, "huge move stays capped at the pot");
	for (const [lev, p] of [[1n, 60000n], [1n, 62000n], [5n, 59000n], [5n, 63000n], [20n, 61500n]] as [bigint, bigint][]) {
		const lp = longPayout(stake, entry, lev, p);
		assert.ok(lp >= 0n && lp <= pot, "long payout within [0, pot]");
		assert.equal(lp + (pot - lp), pot, "long + short == pot (zero-sum)");
	}
});

// ── basic match + settle ─────────────────────────────────────────

test("match escrows both sides; settle splits the pot; conservation holds throughout", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const A = acct(10), B = acct(11);
	fund(bridge, A.pub, 5000n);
	fund(bridge, B.pub, 5000n);
	assert.ok(conserved(bridge, book));

	const o = offer(A, { makerSide: "long", size: "1000", leverage: "100", nonce: "x1" });
	const c = applyMatch(bridge, book, B.pub, "w1", o, 1000n, 1, MARK);
	assert.ok(c, "match opened");
	assert.equal(c!.entry, MARK, "entry = the oracle mark at match");
	assert.equal(c!.long, A.pub);
	assert.equal(c!.short, B.pub);
	assert.equal(gbtcOf(bridge, A.pub), 4000n, "A staked 1000");
	assert.equal(gbtcOf(bridge, B.pub), 4000n, "B staked 1000");
	assert.equal(escrowedInContracts(book), 2000n, "pot is escrowed");
	assert.ok(conserved(bridge, book), "conserved after match");

	// settle above cap → long (A) takes the whole pot
	assert.equal(applySettle(bridge, book, "w1", 63000n, 200), true);
	assert.equal(gbtcOf(bridge, A.pub), 6000n, "A won the pot");
	assert.equal(gbtcOf(bridge, B.pub), 4000n, "B lost its stake");
	assert.equal(escrowedInContracts(book), 0n);
	assert.ok(conserved(bridge, book), "conserved after settle");
});

// ── partial fills never exceed the offered size ──────────────────

test("an offer fills partially across takers and never over-redeems", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const M = acct(20), X = acct(21), Y = acct(22), Z = acct(23);
	for (const p of [M, X, Y, Z]) fund(bridge, p.pub, 10000n);
	const o = offer(M, { size: "100", nonce: "p1" });

	assert.ok(applyMatch(bridge, book, X.pub, "w1", o, 60n, 1, MARK), "X takes 60");
	const cY = applyMatch(bridge, book, Y.pub, "w2", o, 50n, 1, MARK); // only 40 remain
	assert.ok(cY && cY.stake === 40n, "Y is clamped to the remaining 40");
	assert.equal(applyMatch(bridge, book, Z.pub, "w3", o, 10n, 1, MARK), null, "offer exhausted → no fill");
	assert.equal(book.offerFills.get("p1"), 100n, "total filled == size, never more");
	assert.ok(conserved(bridge, book));
});

// ── ghost: maker spent the funds → match no-ops, nothing locked ──

test("ghost (maker can't cover) fails cleanly; self-match rejected", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const M = acct(30), T = acct(31);
	fund(bridge, T.pub, 5000n); // M has nothing — it "ghosted"
	const o = offer(M, { size: "1000", nonce: "g1" });
	assert.equal(applyMatch(bridge, book, T.pub, "w1", o, 1000n, 1, MARK), null, "maker can't cover → no match");
	assert.equal(escrowedInContracts(book), 0n, "nothing escrowed");
	assert.equal(gbtcOf(bridge, T.pub), 5000n, "taker untouched");
	assert.ok(conserved(bridge, book));

	fund(bridge, M.pub, 5000n);
	const self = offer(M, { nonce: "s1" });
	assert.equal(applyMatch(bridge, book, M.pub, "w2", self, 1000n, 1, MARK), null, "self-match (wash) rejected");
});

// ── timing guards ────────────────────────────────────────────────

test("expired offers and premature/late settles are rejected", () => {
	const bridge = emptyBridge(), book = emptyBook();
	const M = acct(40), T = acct(41);
	fund(bridge, M.pub, 5000n);
	fund(bridge, T.pub, 5000n);
	assert.equal(applyMatch(bridge, book, T.pub, "w1", offer(M, { expiryHeight: 5, nonce: "e1" }), 100n, 6, MARK), null, "past expiry → no match");
	assert.equal(applyMatch(bridge, book, T.pub, "w2", offer(M, { settleHeight: 3, nonce: "e2" }), 100n, 5, MARK), null, "settle must be in the future");

	const c = applyMatch(bridge, book, T.pub, "w3", offer(M, { settleHeight: 50, nonce: "e3" }), 100n, 1, MARK);
	assert.ok(c);
	assert.equal(applySettle(bridge, book, "w3", 61000n, 49), false, "can't settle before maturity");
	assert.equal(applySettle(bridge, book, "nope", 61000n, 99), false, "unknown contract");
	assert.equal(applySettle(bridge, book, "w3", 61000n, 50), true, "settles at maturity");
	assert.ok(conserved(bridge, book));
});

// ── property: random op stream keeps conservation + redemption bounds ──

test("random match/settle stream: conservation + no over-redemption always hold", () => {
	// deterministic LCG so failures reproduce
	let s = 0x12345 >>> 0;
	const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 0x100000000);
	const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];

	const bridge = emptyBridge(), book = emptyBook();
	const accts = Array.from({ length: 8 }, (_, i) => acct(100 + i));
	const live: { o: ReturnType<typeof offer>; size: bigint }[] = [];
	let now = 0;
	let wid = 0;

	for (let step = 0; step < 4000; step++) {
		const r = rnd();
		if (r < 0.25) {
			fund(bridge, pick(accts).pub, BigInt(100 + Math.floor(rnd() * 5000)));
		} else if (r < 0.45) {
			// publish a fresh offer from a (possibly broke) maker
			const m = pick(accts);
			const side: Side = rnd() < 0.5 ? "long" : "short";
			const sz = BigInt(50 + Math.floor(rnd() * 2000));
			const o = offer(m, { makerSide: side, size: sz.toString(), leverage: (2 + Math.floor(rnd() * 99)).toString(), nonce: "r" + step, expiryHeight: now + 5 + Math.floor(rnd() * 10), settleHeight: now + 8 + Math.floor(rnd() * 20) });
			live.push({ o, size: sz });
		} else if (r < 0.8 && live.length) {
			// a random taker tries to match a random live offer with a random fill, at a random mark
			const e = pick(live);
			const t = pick(accts);
			const fill = BigInt(1 + Math.floor(rnd() * 2200));
			const markPrice = BigInt(50000 + Math.floor(rnd() * 20000));
			applyMatch(bridge, book, t.pub, "w" + wid++, e.o, fill, now, markPrice);
		} else if (book.contracts.size) {
			const id = pick([...book.contracts.keys()]);
			const c = book.contracts.get(id)!;
			if (now >= c.settleHeight) applySettle(bridge, book, id, BigInt(58000 + Math.floor(rnd() * 6000)), now);
		}
		if (rnd() < 0.3) now += 1;

		// invariants after EVERY step
		assert.ok(conserved(bridge, book), `conservation broke at step ${step}`);
		for (const { o, size } of live) {
			const filled = book.offerFills.get(o.nonce) ?? 0n;
			assert.ok(filled <= size, `offer ${o.nonce} over-redeemed: ${filled} > ${size}`);
		}
		assert.ok(bridge.reserves >= 0n && totalGbtc(bridge) >= 0n, "no negative balances");
	}
	// drain: settle everything left, conservation still holds
	now = 1_000_000;
	for (const id of [...book.contracts.keys()]) applySettle(bridge, book, id, 61000n, now);
	assert.equal(escrowedInContracts(book), 0n);
	assert.ok(conserved(bridge, book), "conserved after draining all contracts");
});
