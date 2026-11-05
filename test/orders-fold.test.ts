/**
 * The order-board fold (src/market/fold.ts) over synthetic certified writes: listing, partial
 * fills and capacity, min fill, dust, self-take, expiry, the proof deadline, abort rules, lock
 * hints, proof-blob shape validation, pruning, and the encoding round-trip.
 *
 *   node --test test/orders-fold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";

import type { Write } from "../src/chain/writer.ts";
import { sha256Hex, toHex } from "../src/det/canonical.ts";
import { computeView, DUST, PROOF_WINDOW, matchLifetime, refundAnchors } from "../src/market/fold.ts";
import { MAX_OFFER_TTL } from "../src/market/ops.ts";
import { deserializeView, serializeView, viewRoot } from "../src/market/state.ts";
import type { View } from "../src/market/state.ts";

const MAKER = "aa".repeat(32);
const TAKER = "bb".repeat(32);
const OTHER = "cc".repeat(32);

const xkey = (): string => toHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const hash = (): string => toHex(schnorr.utils.randomSecretKey());

/** Certified writes at chosen heights; `view(now)` folds them as the anchor at `now` would. */
class Board {
	readonly writes: Write[] = [];
	readonly bornAt = new Map<string, number>();
	private readonly seqs = new Map<string, number>();
	private ts = 0;

	at(h: number, writer: string, payload: unknown): string {
		const seq = this.seqs.get(writer) ?? 0;
		this.seqs.set(writer, seq + 1);
		const id = sha256Hex(`${writer}:${seq}:${++this.ts}`);
		this.writes.push({ id, writer, seq, ts: this.ts, payload } as unknown as Write);
		this.bornAt.set(id, h);
		return id;
	}

	view(now: number): View {
		return computeView(this.writes, now, { bornAt: this.bornAt });
	}
}

const offer = (give: [string, string], want: [string, string], minFill: string, expiresIn = 100) => ({
	kind: "offer.post",
	give: { chain: give[0], amount: give[1] },
	want: { chain: want[0], amount: want[1] },
	minFill,
	expiresIn,
});
const take = (offerId: string, fill: string, h = hash(), takerKey = xkey()) => ({ kind: "offer.take", offerId, fill, hash: h, takerKey });
const utxo = (i: number) => ({ txid: sha256Hex(`utxo${i}`), vout: i, value: "100000" });
const proof = (chain: string, utxos: unknown[] = [utxo(0)]) => ({ chain, net: "regtest", pubkey: xkey(), utxos, sig: "11".repeat(64) });

// 0.01 BTC for 0.4 LTC; min fill 0.001 BTC.
const BTC_FOR_LTC = offer(["bitcoin", "1000000"], ["litecoin", "40000000"], "100000");

test("constants: P2TR dust, refund windows in anchors, match lifetime", () => {
	assert.equal(DUST.bitcoin, 330n);
	assert.equal(DUST.litecoin, 3300n);
	assert.equal(refundAnchors("bitcoin", "initiator"), 1440); // 144 blocks × 600s / 60s
	assert.equal(refundAnchors("litecoin", "initiator"), 1440); // 576 blocks × 150s / 60s
	assert.equal(refundAnchors("bitcoin", "counterparty"), 720);
	assert.equal(matchLifetime("bitcoin"), 10 + 30 + 1440 + 720);
});

test("offer.post lists an offer; malformed or dust offers are ignored", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const bad = [
		offer(["bitcoin", "1000000"], ["bitcoin", "40000000"], "100000"), // same chain
		offer(["bitcoin", "0"], ["litecoin", "40000000"], "1"), // zero
		offer(["bitcoin", "01000000"], ["litecoin", "40000000"], "100000"), // non-canonical decimal
		offer(["bitcoin", "1000000"], ["litecoin", "40000000"], "1000001"), // minFill > give
		offer(["bitcoin", "1000000"], ["litecoin", "3299"], "1000000"), // want leg is dust
		offer(["bitcoin", "1000000"], ["litecoin", "40000000"], "329"), // minFill is dust (give side)
		offer(["bitcoin", "1000000"], ["litecoin", "4000000"], "800"), // minFill pro-rata want = 3200 lit < 3300 dust
		offer(["bitcoin", "1000000"], ["litecoin", "40000000"], "100000", 0), // ttl 0
		offer(["bitcoin", "1000000"], ["litecoin", "40000000"], "100000", MAX_OFFER_TTL + 1), // ttl over cap
		{ ...BTC_FOR_LTC, extra: 1 }, // unknown key
		{ ...BTC_FOR_LTC, give: { chain: "bitcoin", amount: 1000000 } }, // number, not decimal string
		{ ...BTC_FOR_LTC, kind: "offer.Post" },
	];
	for (const p of bad) b.at(1, MAKER, p);
	const v = b.view(1);
	assert.deepEqual([...v.offers.keys()], [id], "only the well-formed offer is listed");
	const o = v.offers.get(id)!;
	assert.equal(o.maker, MAKER);
	assert.equal(o.remaining, 1000000n);
	assert.equal(o.postedAt, 1);
	assert.equal(o.expiresAt, 101);
});

test("partial fills reserve capacity; pro-rata want floors; min fill and remaining bound each take", () => {
	const b = new Board();
	const id = b.at(1, MAKER, offer(["bitcoin", "1000003"], ["litecoin", "7777777"], "100000"));
	const m1 = b.at(2, TAKER, take(id, "300001"));
	const tooSmall = b.at(2, OTHER, take(id, "99999"));
	const m2 = b.at(3, OTHER, take(id, "600000"));
	const tooBig = b.at(3, TAKER, take(id, "100003")); // remaining is 100002
	const m3 = b.at(4, TAKER, take(id, "100002"));
	const v = b.view(4);
	assert.equal(v.offers.get(id)!.remaining, 0n, "fully reserved");
	assert.ok(!v.matches.has(tooSmall) && !v.matches.has(tooBig));
	const a = v.matches.get(m1)!;
	assert.equal(a.makerAmount, 300001n);
	assert.equal(a.takerAmount, (300001n * 7777777n) / 1000003n, "floor(fill × want / give)");
	assert.equal(a.makerChain, "bitcoin");
	assert.equal(a.takerChain, "litecoin");
	assert.equal(a.makerRefundBlocks, 72, "maker (counterparty) locks BTC for 12h");
	assert.equal(a.takerRefundBlocks, 576, "taker (initiator) locks LTC for 24h");
	assert.equal(a.takeSeq, 0);
	assert.equal(a.status, "awaitingProofs");
	assert.equal(a.proofDeadline, 2 + PROOF_WINDOW);
	assert.ok(v.matches.has(m2) && v.matches.has(m3));
	assert.equal(v.matches.get(m3)!.takeSeq, 2, "taker's third write");
});

test("a maker cannot take its own offer; a reused hash or a malformed take is ignored", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const self = b.at(2, MAKER, take(id, "100000"));
	const h = hash();
	const first = b.at(2, TAKER, take(id, "100000", h));
	const reuse = b.at(2, OTHER, take(id, "100000", h));
	const badKey = b.at(2, OTHER, take(id, "100000", hash(), "00".repeat(32))); // not on the curve
	const upper = b.at(2, OTHER, take(id, "100000", hash().toUpperCase()));
	const v = b.view(2);
	assert.deepEqual([...v.matches.keys()], [first]);
	for (const x of [self, reuse, badKey, upper]) assert.ok(!v.matches.has(x));
	assert.equal(v.offers.get(id)!.remaining, 900000n);
});

test("offers expire at postedAt + expiresIn; a take at the expiry height is too late", () => {
	const b = new Board();
	const id = b.at(1, MAKER, { ...BTC_FOR_LTC, expiresIn: 5 });
	assert.ok(b.view(5).offers.has(id), "live through height 5");
	const late = b.at(6, TAKER, take(id, "100000"));
	const v = b.view(6);
	assert.equal(v.offers.size, 0, "gone at height 6");
	assert.ok(!v.matches.has(late));
});

test("only the maker cancels an offer; open matches keep their reserved fill", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "100000"));
	b.at(3, TAKER, { kind: "offer.cancel", offerId: id });
	assert.ok(b.view(3).offers.has(id), "a non-maker's cancel is ignored");
	b.at(4, MAKER, { kind: "offer.cancel", offerId: id });
	const v = b.view(4);
	assert.ok(!v.offers.has(id));
	assert.equal(v.matches.get(m)!.status, "awaitingProofs", "the match survives its offer");
	b.at(5, MAKER, { kind: "swap.abort", matchId: m });
	assert.equal(b.view(5).matches.get(m)!.status, "cancelled", "aborting after cancel restores nothing, breaks nothing");
});

test("both proofs → escrow; maker's proof must carry makerKey; per-side chain + first proof wins", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "100000"));
	const makerKey = xkey();
	b.at(3, MAKER, { kind: "swap.proof", matchId: m, proof: proof("bitcoin") }); // no makerKey
	b.at(3, MAKER, { kind: "swap.proof", matchId: m, makerKey, proof: proof("litecoin") }); // wrong chain
	b.at(3, TAKER, { kind: "swap.proof", matchId: m, makerKey: xkey(), proof: proof("litecoin") }); // taker can't set makerKey
	b.at(3, OTHER, { kind: "swap.proof", matchId: m, proof: proof("litecoin") }); // not a party
	let x = b.view(3).matches.get(m)!;
	assert.equal(x.makerProof, null);
	assert.equal(x.takerProof, null);
	const tp = proof("litecoin");
	b.at(4, TAKER, { kind: "swap.proof", matchId: m, proof: tp });
	b.at(4, TAKER, { kind: "swap.proof", matchId: m, proof: proof("litecoin") }); // second one ignored
	x = b.view(4).matches.get(m)!;
	assert.equal(x.status, "awaitingProofs");
	assert.equal(x.takerProof!.pubkey, tp.pubkey);
	b.at(5, MAKER, { kind: "swap.proof", matchId: m, makerKey, proof: proof("bitcoin") });
	x = b.view(5).matches.get(m)!;
	assert.equal(x.status, "escrow");
	assert.equal(x.makerKey, makerKey);
	assert.equal(b.view(5000).offers.size, 0, "sanity: the offer itself expires");
});

test("malformed proof blobs are ignored (shape only — the fold never verifies funds)", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "100000"));
	const blobs = [
		proof("litecoin", Array.from({ length: 33 }, (_, i) => utxo(i))), // > 32 utxos
		proof("litecoin", []), // empty
		proof("litecoin", [utxo(1), utxo(1)]), // duplicate outpoint
		proof("litecoin", [{ ...utxo(1), value: "0" }]),
		proof("litecoin", [{ ...utxo(1), value: "007" }]),
		proof("litecoin", [{ ...utxo(1), vout: -1 }]),
		proof("litecoin", [{ ...utxo(1), txid: utxo(1).txid.toUpperCase() }]),
		proof("litecoin", [{ ...utxo(1), extra: true }]),
		{ ...proof("litecoin"), sig: "11".repeat(63) },
		{ ...proof("litecoin"), net: "signet" },
		{ ...proof("litecoin"), extra: 1 },
		null,
		"proof",
	];
	for (const p of blobs) b.at(3, TAKER, { kind: "swap.proof", matchId: m, proof: p });
	assert.equal(b.view(3).matches.get(m)!.takerProof, null);
	b.at(4, TAKER, { kind: "swap.proof", matchId: m, proof: proof("litecoin", Array.from({ length: 32 }, (_, i) => utxo(i))) });
	assert.equal(b.view(4).matches.get(m)!.takerProof!.utxos.length, 32, "32 utxos is the cap, inclusive");
});

test("a missing proof at the deadline cancels the match and restores capacity", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "250000"));
	b.at(5, TAKER, { kind: "swap.proof", matchId: m, proof: proof("litecoin") });
	const deadline = 2 + PROOF_WINDOW;
	let v = b.view(deadline);
	assert.equal(v.matches.get(m)!.status, "awaitingProofs", "still open AT the deadline");
	assert.equal(v.offers.get(id)!.remaining, 750000n);
	b.at(deadline + 1, MAKER, { kind: "swap.proof", matchId: m, makerKey: xkey(), proof: proof("bitcoin") }); // too late
	v = b.view(deadline + 1);
	const x = v.matches.get(m)!;
	assert.equal(x.status, "cancelled");
	assert.deepEqual(x.cancelled, { at: deadline + 1, reason: "noProof" });
	assert.equal(x.makerProof, null, "a proof after the deadline is ignored");
	assert.equal(v.offers.get(id)!.remaining, 1000000n, "capacity restored");
	assert.deepEqual(b.view(deadline + 7).matches.get(m)!.cancelled, { at: deadline + 1, reason: "noProof" }, "stamped with the deadline, not the observing height");
});

test("abort: maker only, restores capacity, barred once the maker has locked", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m1 = b.at(2, TAKER, take(id, "100000"));
	const m2 = b.at(2, OTHER, take(id, "200000"));
	for (const [m, p] of [[m1, TAKER], [m2, OTHER]] as const) {
		b.at(3, p, { kind: "swap.proof", matchId: m, proof: proof("litecoin") });
		b.at(3, MAKER, { kind: "swap.proof", matchId: m, makerKey: xkey(), proof: proof("bitcoin") });
	}
	const lock = (matchId: string) => ({ kind: "swap.locked", matchId, txid: sha256Hex(matchId), vout: 1 });
	b.at(4, TAKER, { kind: "swap.abort", matchId: m1 }); // taker can't abort
	b.at(4, TAKER, lock(m1)); // a taker lock doesn't bar the maker's abort
	b.at(4, OTHER, lock(m2));
	b.at(4, MAKER, lock(m2)); // maker locked m2
	let v = b.view(4);
	assert.equal(v.matches.get(m1)!.status, "escrow");
	assert.deepEqual(v.matches.get(m1)!.takerLock, { txid: sha256Hex(m1), vout: 1, at: 4 });
	assert.ok(v.matches.get(m2)!.makerLock);
	assert.equal(v.offers.get(id)!.remaining, 700000n);
	b.at(5, MAKER, { kind: "swap.abort", matchId: m2 }); // after maker lock → ignored
	b.at(5, MAKER, { kind: "swap.abort", matchId: m1 });
	v = b.view(5);
	assert.equal(v.matches.get(m2)!.status, "escrow");
	assert.deepEqual(v.matches.get(m1)!.cancelled, { at: 5, reason: "abort" });
	assert.equal(v.offers.get(id)!.remaining, 800000n, "m1's fill is back on the board");
	b.at(6, MAKER, { kind: "swap.abort", matchId: m1 }); // twice → no double restore
	b.at(6, TAKER, lock(m1)); // hints after cancel are ignored
	assert.equal(b.view(6).offers.get(id)!.remaining, 800000n);
});

test("lock hints need escrow, a party, and record once per side", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "100000"));
	b.at(3, TAKER, { kind: "swap.locked", matchId: m, txid: "ab".repeat(32), vout: 0 }); // not in escrow yet
	b.at(4, TAKER, { kind: "swap.proof", matchId: m, proof: proof("litecoin") });
	b.at(4, MAKER, { kind: "swap.proof", matchId: m, makerKey: xkey(), proof: proof("bitcoin") });
	b.at(5, OTHER, { kind: "swap.locked", matchId: m, txid: "cd".repeat(32), vout: 0 });
	b.at(5, MAKER, { kind: "swap.locked", matchId: m, txid: "ef".repeat(32), vout: 2 ** 32 }); // vout out of range
	b.at(6, MAKER, { kind: "swap.locked", matchId: m, txid: "ef".repeat(32), vout: 3 });
	b.at(7, MAKER, { kind: "swap.locked", matchId: m, txid: "12".repeat(32), vout: 4 });
	const x = b.view(7).matches.get(m)!;
	assert.equal(x.takerLock, null);
	assert.deepEqual(x.makerLock, { txid: "ef".repeat(32), vout: 3, at: 6 });
});

test("match records are pruned at takenAt + matchLifetime(takerChain)", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "100000"));
	b.at(3, TAKER, { kind: "swap.proof", matchId: m, proof: proof("litecoin") });
	b.at(3, MAKER, { kind: "swap.proof", matchId: m, makerKey: xkey(), proof: proof("bitcoin") });
	const pruneAt = 2 + matchLifetime("litecoin");
	assert.equal(b.view(pruneAt - 1).matches.get(m)!.pruneAt, pruneAt);
	assert.equal(b.view(pruneAt).matches.size, 0);
	assert.equal(b.view(pruneAt).offers.size, 0, "the offer expired long before");
});

test("the encoding round-trips exactly and rejects junk", () => {
	const b = new Board();
	const id = b.at(1, MAKER, BTC_FOR_LTC);
	const m = b.at(2, TAKER, take(id, "100000"));
	b.at(3, TAKER, { kind: "swap.proof", matchId: m, proof: proof("litecoin") });
	const v = b.view(3);
	const s = serializeView(v);
	assert.equal(viewRoot(deserializeView(s)), viewRoot(v));
	assert.deepEqual(deserializeView(JSON.parse(JSON.stringify(s))), v);
	assert.throws(() => deserializeView({ ...s, extra: [] } as never), /canonical/);
	assert.throws(() => deserializeView({ ...s, offers: [{ ...s.offers[0], junk: 1 }] } as never), /canonical/);
	assert.throws(() => deserializeView({ ...s, matches: [{ ...s.matches[0], takerProof: { ...s.matches[0].takerProof!, junk: 1 } }] } as never), /canonical/);
	assert.throws(() => deserializeView({ ...s, offers: [{ ...s.offers[0], remaining: "0100000" }] } as never), /canonical/);
	assert.throws(() => deserializeView({ offers: [s.offers[0], s.offers[0]], matches: [] } as never), /canonical/, "duplicate ids");
	assert.throws(() => deserializeView({} as never), /canonical/);
});

test("folding in any number of splits from a resumed base reaches the identical root", () => {
	const b = new Board();
	const id = b.at(1, MAKER, { ...BTC_FOR_LTC, expiresIn: 20 });
	const id2 = b.at(1, OTHER, offer(["litecoin", "50000000"], ["bitcoin", "1200000"], "5000000", 2880));
	const m1 = b.at(2, TAKER, take(id, "100000"));
	const m2 = b.at(3, OTHER, take(id, "300000"));
	const m3 = b.at(3, TAKER, take(id2, "5000000"));
	b.at(4, TAKER, { kind: "swap.proof", matchId: m1, proof: proof("litecoin") });
	b.at(5, MAKER, { kind: "swap.proof", matchId: m1, makerKey: xkey(), proof: proof("bitcoin") });
	b.at(6, OTHER, { kind: "swap.proof", matchId: m2, proof: proof("litecoin") }); // maker never proves → noProof at 14
	b.at(9, TAKER, { kind: "swap.locked", matchId: m1, txid: "ab".repeat(32), vout: 0 });
	b.at(15, OTHER, { kind: "swap.abort", matchId: m3 }); // m3 already cancelled at 14 → ignored
	b.at(16, TAKER, take(id, "300000")); // capacity restored by m2's cancel
	const end = 30; // offer `id` expired at 21
	const full = b.view(end);
	assert.equal(full.matches.get(m2)!.status, "cancelled");
	assert.equal(full.matches.get(m1)!.status, "escrow");
	assert.ok(!full.offers.has(id) && full.offers.has(id2));

	const below = (h: number) => b.writes.filter((w) => b.bornAt.get(w.id)! <= h);
	const above = (h: number) => b.writes.filter((w) => b.bornAt.get(w.id)! > h);
	// one checkpoint at every height
	for (let c = 0; c <= end; c++) {
		const base = computeView(below(c), c, { bornAt: b.bornAt });
		assert.equal(viewRoot(computeView(above(c), end, { bornAt: b.bornAt, base })), viewRoot(full), `checkpoint at ${c}`);
	}
	// a chain of checkpoints, one per height
	let base: View | undefined;
	for (let h = 0; h <= end; h++) base = computeView(b.writes.filter((w) => b.bornAt.get(w.id) === h), h, { bornAt: b.bornAt, base });
	assert.equal(viewRoot(base!), viewRoot(full), "split at every height");
});
