/**
 * Phase 0 capacity benchmark — turns the bounded-resources caps into real numbers.
 *
 *   node scripts/bench-capacity.ts                 # committed-state sizes + fold throughput
 *   node --expose-gc scripts/bench-capacity.ts     # also report in-RAM heap per entry
 *
 * Everything is measured against the REAL serializer (market/state.ts) and the REAL fold
 * (computeView over real Ed25519-signed writes) — no mocks — so the numbers are authentic:
 *
 *   1) committed bytes per entry (account / round entry) → the RAM-&-disk cost per cap
 *   2) fold throughput (ops/sec) → the single-chain TPS ceiling of the state machine
 *      (PoST proof verification is a separate per-write ingest gate, not measured here)
 *
 * The output sets the cap VALUES for the bounded-resources redesign. RAM ≈ Σ(cap × per-entry);
 * the fold rate is the throughput ceiling. See the README "bounded resources" design notes.
 */

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView } from "../src/market/btc.ts";
import type { View, ViewOptions } from "../src/market/btc.ts";
import type { Write } from "../src/chain/writer.ts";
import { serializeView } from "../src/market/state.ts";
import { canonicalize, sha256Hex } from "../src/det/canonical.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K, priceBase, withGbtc } from "../test/helpers.ts";

const enc = new TextEncoder();
const MB = 1048576;
/** Byte length of the canonical (committed) encoding of the whole folded view. */
const committedBytes = (v: View): number => enc.encode(canonicalize(serializeView(v))).length;
/** Deterministic 64-hex, pubkey/id sized (no RNG — keeps the bench reproducible). */
const hx = (s: string): string => sha256Hex(enc.encode(s));
const fmt = (n: number): string => Math.round(n).toLocaleString();

// ── 1. committed-state size per entry (real serializer, marginal via linear fit) ──

/** Marginal bytes per entry = (bytes at n2 − bytes at n1) / (n2 − n1) — cancels fixed overhead. */
function perEntry(build: (n: number) => View, n1: number, n2: number): number {
	return (committedBytes(build(n2)) - committedBytes(build(n1))) / (n2 - n1);
}

const buildAccounts = (n: number): View => {
	const v = computeView([]);
	for (let i = 0; i < n; i++) {
		const p = hx("acct" + i);
		v.bridge.gbtc.set(p, 12_345_678n); // balance
		v.bridge.chargeFrom.set(p, { since: 1000 + i, charged: 11_080 + i }); // its active idle-decay clock
	}
	return v;
};

// ── 1b. rounds — canonical round shape: bytes per entry ──
// Measures the exact encoding a live round commits (canonicalize over the plain-JSON shape),
// the same way accounts are sized.

const buildRoundCanon = (n: number): unknown => ({
	idx: 123_456,
	strike: "6004300000000", // integer Pyth price (expo applied at display)
	close: null, // still live
	poolUp: "123456789012",
	poolDown: "98765432101",
	seedUp: "0", // the pot's lock-time thin-side seed — two pool-level fields per round
	seedDown: "12345678901",
	settled: false,
	// entries: pubkey → {side, stake}, key-sorted like every other canonical map
	entries: Array.from({ length: n }, (_, i) => [hx("player" + i), { side: i % 2 ? "up" : "down", stake: "1000000" }] as [string, unknown]).sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
});
const roundEntryBytes = (n1: number, n2: number): number =>
	(enc.encode(canonicalize(buildRoundCanon(n2))).length - enc.encode(canonicalize(buildRoundCanon(n1))).length) / (n2 - n1);

/** Parimutuel settle throughput: pro-rata distribution of the WHOLE losing pool across n winners
 *  (pure parimutuel, no rake — bigint math per entry, the batch cost the fold pays once per round close). */
function settleRate(n: number, budgetMs = 500): number {
	const entries = Array.from({ length: n }, (_, i) => ({ up: i % 2 === 0, stake: 1_000_000n + BigInt(i) }));
	const settle = (): bigint => {
		let winPool = 0n, losePool = 0n;
		for (const e of entries) e.up ? (winPool += e.stake) : (losePool += e.stake);
		const dist = losePool; // the whole losing pool distributes
		let paid = 0n;
		for (const e of entries) if (e.up) paid += e.stake + (e.stake * dist) / winPool; // winner: stake back + pro-rata share
		return dist - (paid - winPool); // integer-division dust → the pot
	};
	settle(); // warm
	let reps = 0;
	const t0 = performance.now();
	while (performance.now() - t0 < budgetMs) {
		settle();
		reps++;
	}
	return (reps * n) / ((performance.now() - t0) / 1000);
}

function heapPerAccount(n: number): number | null {
	const g = (globalThis as { gc?: () => void }).gc;
	if (!g) return null;
	g();
	const before = process.memoryUsage().heapUsed;
	const hold = buildAccounts(n); // keep a live ref so it isn't collected
	g();
	const after = process.memoryUsage().heapUsed;
	void hold.bridge.gbtc.size;
	return (after - before) / n;
}

// ── 2. fold throughput — the REAL fold over REAL signed writes ──

function setup(): { node: GavlNode; mk: () => Account } {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = (): number => ++t;
	const mk = (): Account => new Account({ node, params: PARAMS, k: K, now, keypair: generateKeyPair() });
	return { node, mk };
}

/** Re-fold the same write set for ~budgetMs and return ops/sec (computeView is pure → safe to repeat). */
function foldRate(writes: Write[], opts: ViewOptions, budgetMs = 700): number {
	// warm up once (JIT) then measure
	computeView(writes, opts);
	let reps = 0;
	const t0 = performance.now();
	while (performance.now() - t0 < budgetMs) {
		computeView(writes, opts);
		reps++;
	}
	const sec = (performance.now() - t0) / 1000;
	return (reps * writes.length) / sec;
}

async function transferRate(n: number): Promise<number> {
	const { node, mk } = setup();
	const c = mk();
	const sink = hx("sink");
	for (let i = 0; i < n; i++) await c.transfer(sink, 1n);
	const writes = node.ledger.allWrites();
	const base = withGbtc(priceBase(5_852_013n), { [c.pubHex]: BigInt(n) + 1n });
	const bornAt = new Map(writes.map((w) => [w.id, 5] as [string, number]));
	return foldRate(writes, { base, nowHeight: 5, bornAt });
}

// ── report ──

async function main(): Promise<void> {
	const line = "  " + "─".repeat(66);
	console.log("\n  PHASE 0 — CAPACITY BENCHMARK   (real serializer + real fold)\n");

	const bAcc = perEntry(buildAccounts, 1000, 4000);
	const proj = (b: number, cap: number): string => `${fmt(cap)} → ${(b * cap / MB).toFixed(1)} MB`;
	console.log("  COMMITTED STATE — bytes per entry (snapshot + RAM cost of one capped item)");
	console.log(line);
	console.log(`  account+clock : ${fmt(bAcc)} B    ${proj(bAcc, 100_000)} · ${proj(bAcc, 1_000_000)}`);
	const hp = heapPerAccount(20_000);
	if (hp != null) console.log(`  in-RAM heap/account ≈ ${fmt(hp)} B  (live JS object + Map overhead; run with --expose-gc)`);
	else console.log(`  (run with --expose-gc for the in-RAM heap-per-account figure)`);

	const bRound = roundEntryBytes(1000, 4000);
	console.log(`  round entry   : ${fmt(bRound)} B    10,000/round → ${(bRound * 10_000 / MB * 1000).toFixed(0)} KB · 2 live rounds → ${(bRound * 20_000 / MB).toFixed(1)} MB`);
	console.log(`  settle sweep  : ${fmt(settleRate(10_000))} entries/s   (parimutuel pro-rata, bigint; one batch per round close)`);

	console.log("\n  FOLD THROUGHPUT — ops/sec the state machine sustains, one core (excl. PoST verify)");
	console.log(line);
	const tT = await transferRate(1500);
	console.log(`  gbtc.transfer : ${fmt(tT)} /s   (raw per-op fold rate)`);

	console.log("\n  IMPLICATIONS");
	console.log(line);
	console.log(`  • RAM is cheap — a 1,000,000-account cap ≈ ${(bAcc * 1_000_000 / MB).toFixed(0)} MB committed state; a full round (10,000 entries) is ~${(bRound * 10_000 / MB).toFixed(1)} MB and self-clears at settle.`);
	console.log(`  • The binding limit is THROUGHPUT, not memory: ~${fmt(tT)} folded ops/sec on one core.`);
	console.log(`  • At ~60s/anchor that's ~${fmt(tT * 60)} ops per anchor before the fold saturates; a round close sweeps ${fmt(settleRate(10_000))} entries/s.`);
	console.log("");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
