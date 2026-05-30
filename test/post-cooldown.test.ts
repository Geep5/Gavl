/**
 * P0 — Chia-style Proof-of-Space-Time cooldown ledger.
 *
 * Proves the properties the design rests on:
 *   - a write is self-verifying (space + time + signature), no history needed
 *   - quality → required cooldown: more space buys proportionally more throughput
 *   - the VDF is infused with the space proof (time bound to space)
 *   - the challenge is foliage-independent (cannot grind the cooldown via payload)
 *   - the cooldown is structurally serial (write N+1 depends on write N's id)
 *   - the cooldown is observably serial in wall-clock (non-parallelizable)
 *   - tampering with any proof is rejected
 *   - forking your own chain (double-spend) is caught as equivocation
 *   - every identity owes its own plot, and plots cannot be borrowed
 *
 *   node --test test/post-cooldown.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Writer, WriterChain, verifyWrite, challengeOf } from "../src/chain/writer.ts";
import type { Write, ChainParams } from "../src/chain/writer.ts";
import { requiredIters, vdfChallenge } from "../src/chain/iters.ts";
import { HashVdf } from "../src/pot/hash-vdf.ts";
import { sha256Hex, toHex } from "../src/det/canonical.ts";

const PARAMS: ChainParams = {
	vdf: new HashVdf(),
	difficulty: 160n,
	dcf: 1n << 20n,
	floorIters: 2_000n,
};
const K = 12; // 4096-leaf plot — small and fast
const ZERO_ROOT = "00".repeat(32);

test("a valid PoST chain verifies write-by-write, appends, and accrues weight", async () => {
	const w = new Writer({ k: K, params: PARAMS });
	const chain = new WriterChain({ writer: w.pubHex, plot: w.plot.commitment, params: PARAMS });

	let prev: string | null = null;
	let seq = 0;
	for (const payload of [{ op: "create" }, { op: "bid" }, { op: "settle" }]) {
		const wr = await w.write({ prev, seq, stateRoot: ZERO_ROOT, payload, ts: 1000 + seq });
		assert.equal(verifyWrite(wr, PARAMS).ok, true, "write should self-verify");
		const r = chain.append(wr);
		assert.equal(r.ok, true, r.ok ? "" : r.reason);
		prev = wr.id;
		seq++;
	}
	assert.equal(chain.writes.length, 3);
	assert.equal(chain.weight, PARAMS.difficulty * 3n, "weight = sum of difficulty");
});

test("more space → shorter required cooldown (space buys throughput, Chia-style)", async () => {
	const small = new Writer({ k: 10, params: PARAMS }); // 1,024 leaves
	const big = new Writer({ k: 14, params: PARAMS }); // 16,384 leaves

	let sumSmall = 0n;
	let sumBig = 0n;
	const T = 6;
	for (let i = 0; i < T; i++) {
		const sr = sha256Hex("round-" + i); // vary the challenge across rounds
		const cSmall = challengeOf({ writer: small.pubHex, seq: 0, prev: null, stateRoot: sr });
		const cBig = challengeOf({ writer: big.pubHex, seq: 0, prev: null, stateRoot: sr });
		sumSmall += requiredIters(small.plot.prove(cSmall).quality, PARAMS);
		sumBig += requiredIters(big.plot.prove(cBig).quality, PARAMS);
	}
	// 16× the leaves → ~16× smaller best-quality → ~16× fewer required iters.
	console.log(`    [space→rate] k=10 Σiters=${sumSmall}  k=14 Σiters=${sumBig}  (ratio ${(Number(sumSmall) / Number(sumBig)).toFixed(1)}×)`);
	assert.ok(sumBig < sumSmall, `bigger plot must need fewer iters: big=${sumBig} small=${sumSmall}`);
});

test("the VDF is infused with the space proof (time is bound to space)", async () => {
	const w = new Writer({ k: K, params: PARAMS });
	const wr = await w.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: { op: "create" }, ts: 1 });
	const challenge = challengeOf({ writer: wr.writer, seq: wr.seq, prev: wr.prev, stateRoot: wr.stateRoot });

	// Verifies against the infused challenge (challenge ‖ space proof)...
	assert.equal(PARAMS.vdf.verify(vdfChallenge(challenge, wr.space.value), wr.time), true);
	// ...but NOT against the bare challenge — the binding is real.
	assert.equal(PARAMS.vdf.verify(challenge, wr.time), false);
});

test("the challenge is foliage-independent: payload cannot move the cooldown", async () => {
	const w = new Writer({ k: K, params: PARAMS });
	const a = await w.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: { op: "create", item: "sword" }, ts: 1 });
	const b = await w.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: { op: "mint", amount: 999 }, ts: 1 });
	// Same trunk (writer/seq/prev/stateRoot) ⇒ identical challenge, proof, and required cooldown,
	// regardless of payload. So you cannot grind a cheaper cooldown by varying what you write.
	assert.equal(a.space.quality, b.space.quality, "same challenge ⇒ same proof quality");
	assert.equal(a.time.iters, b.time.iters, "same proof ⇒ same required cooldown");
	assert.notEqual(a.id, b.id, "but the payload still distinguishes the writes (foliage)");
});

test("tampering with difficulty, cooldown, time, payload, or space proof is rejected", async () => {
	const w = new Writer({ k: K, params: PARAMS });
	const good = await w.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: { op: "create" }, ts: 1 });
	assert.equal(verifyWrite(good, PARAMS).ok, true);

	// Lowered difficulty to cheat the required-iters formula → rejected.
	const lowDiff: Write = { ...good, difficulty: "1" };
	assert.equal(verifyWrite(lowDiff, PARAMS).ok, false);

	// Under-served cooldown: re-run the VDF for one fewer than required.
	const challenge = challengeOf({ writer: good.writer, seq: good.seq, prev: good.prev, stateRoot: good.stateRoot });
	const need = requiredIters(good.space.quality, PARAMS);
	const shortTime = await PARAMS.vdf.eval(vdfChallenge(challenge, good.space.value), Number(need) - 1);
	assert.equal(verifyWrite({ ...good, time: shortTime }, PARAMS).ok, false);

	// Tampered VDF output, swapped payload, corrupted Merkle path → all rejected.
	assert.equal(verifyWrite({ ...good, time: { ...good.time, output: "ab".repeat(32) } }, PARAMS).ok, false);
	assert.equal(verifyWrite({ ...good, payload: { op: "mint", amount: 1_000_000 } }, PARAMS).ok, false);
	assert.equal(verifyWrite({ ...good, space: { ...good.space, path: good.space.path.map(() => "11".repeat(32)) } }, PARAMS).ok, false);
});

test("the cooldown is structurally serial: write N+1's challenge is bound to write N's id", async () => {
	const w = new Writer({ k: K, params: PARAMS });
	const a = await w.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: { i: 0 }, ts: 0 });
	const b = await w.write({ prev: a.id, seq: 1, stateRoot: ZERO_ROOT, payload: { i: 1 }, ts: 1 });

	const realChallenge = challengeOf({ writer: b.writer, seq: b.seq, prev: b.prev, stateRoot: b.stateRoot });
	assert.equal(PARAMS.vdf.verify(vdfChallenge(realChallenge, b.space.value), b.time), true);

	// Had prev been anything else, the challenge — and the whole proof — differs.
	const altChallenge = challengeOf({ writer: b.writer, seq: b.seq, prev: "ff".repeat(32), stateRoot: b.stateRoot });
	assert.notEqual(toHex(realChallenge), toHex(altChallenge));
	// => you cannot precompute b's cooldown before a exists. The chain is serial.
});

test("the cooldown is observably serial in wall-clock (non-parallelizable)", async () => {
	const w = new Writer({ k: K, params: PARAMS });

	// Measure the per-iteration cost in isolation (warm up first).
	const probe = await PARAMS.vdf.eval(new Uint8Array(32), 40_000);
	const s0 = process.hrtime.bigint();
	await PARAMS.vdf.eval(new Uint8Array(32), probe.iters);
	const perIterMs = Number(process.hrtime.bigint() - s0) / 1e6 / probe.iters;

	// Produce a chain; each write pays its own (quality-determined) cooldown in sequence.
	const N = 4;
	let prev: string | null = null;
	let totalIters = 0;
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < N; i++) {
		const wr = await w.write({ prev, seq: i, stateRoot: ZERO_ROOT, payload: { i }, ts: i });
		totalIters += wr.time.iters;
		prev = wr.id;
	}
	const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
	const expectedMs = totalIters * perIterMs;

	console.log(`    [serial] ${N} writes, ${totalIters} VDF iters ≈ ${totalMs.toFixed(0)}ms (expected ≥ ${(expectedMs * 0.5).toFixed(0)}ms)`);
	// The total work is sumIters sequential hashes; it cannot complete in less unless the VDF parallelizes.
	assert.ok(totalMs >= expectedMs * 0.5, `serial cost too low: ${totalMs.toFixed(0)}ms < ${(expectedMs * 0.5).toFixed(0)}ms`);
});

test("forking your own chain (double-spend) is caught as equivocation", async () => {
	const w = new Writer({ k: K, params: PARAMS });
	const chain = new WriterChain({ writer: w.pubHex, plot: w.plot.commitment, params: PARAMS });

	const w0 = await w.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: { op: "create" }, ts: 0 });
	assert.equal(chain.append(w0).ok, true);

	// Two conflicting writes at seq 1 off the same parent — spend the same coin twice.
	const spendBob = await w.write({ prev: w0.id, seq: 1, stateRoot: ZERO_ROOT, payload: { pay: "bob" }, ts: 1 });
	const spendCarol = await w.write({ prev: w0.id, seq: 1, stateRoot: ZERO_ROOT, payload: { pay: "carol" }, ts: 1 });

	assert.equal(chain.append(spendBob).ok, true);
	const r = chain.append(spendCarol);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.equal(r.reason, "equivocation");
		assert.ok(r.equivocation, "fork proof should carry both conflicting writes");
		const [x, y] = r.equivocation!;
		assert.equal(verifyWrite(x, PARAMS).ok, true);
		assert.equal(verifyWrite(y, PARAMS).ok, true);
		assert.equal(x.seq, y.seq);
		assert.notEqual(x.id, y.id);
	}
});

test("every identity owes its own plot, and plots cannot be borrowed", async () => {
	const M = 3;
	const roots = new Set<string>();
	for (let i = 0; i < M; i++) {
		const id = new Writer({ k: K, params: PARAMS });
		roots.add(id.plot.commitment.root);
	}
	assert.equal(roots.size, M, "each identity's plot root is unique (bound to its pubkey)");

	const a = new Writer({ k: K, params: PARAMS });
	const b = new Writer({ k: K, params: PARAMS });
	const wa = await a.write({ prev: null, seq: 0, stateRoot: ZERO_ROOT, payload: {}, ts: 0 });
	const borrowed: Write = { ...wa, plot: b.plot.commitment };
	assert.equal(verifyWrite(borrowed, PARAMS).ok, false, "A must not pass off B's plot as its own");
});
