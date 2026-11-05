/**
 * The application-state commitment (market/state.ts) — the load-bearing piece of
 * state-committed checkpoints. Two requirements, both consensus-critical:
 *
 *   1. ORDER-INDEPENDENCE: the same logical state hashes to the same viewRoot no
 *      matter what order Maps/Sets were filled in (else nodes fork).
 *   2. LOSSLESS ROUND-TRIP: deserialize(serialize(v)) reproduces v exactly, so a
 *      node can load a snapshot and keep folding as if it had the history.
 *
 *   node --test test/state-root.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeView, deserializeView, viewRoot } from "../src/market/state.ts";
import { emptyBridge } from "../src/custody/bridge.ts";
import type { View } from "../src/market/btc.ts";

/** Build a richly-populated View; `rev` reverses insertion order to probe order-independence. */
function makeView(rev = false): View {
	const bridge = emptyBridge();
	const gbtc: [string, bigint][] = [["aa", 100n], ["bb", 250n], ["cc", 7n]];
	const claims: [string, { depositor: string; height: number }][] = [["dep1:0", { depositor: "aa", height: 3 }], ["dep2:1", { depositor: "cc", height: 7 }]];
	const broadcasts: [string, string][] = [["w1", "txa"], ["w2", "txb"]];
	const order = <T>(xs: T[]) => (rev ? [...xs].reverse() : xs);
	for (const [k, v] of order(gbtc)) bridge.gbtc.set(k, v);
	for (const [k, v] of order(claims)) bridge.claims.set(k, v);
	for (const [k, v] of order(broadcasts)) bridge.broadcasts.set(k, v);
	const excluded = new Map<string, number>();
	for (const [k, h] of order<[string, number]>([["ee", 20], ["ff", 33]])) excluded.set(k, h);
	for (const d of order(["aa", "cc", "zz"])) bridge.depositors.add(d);
	for (const p of order(["dep1:0", "dep2:1"])) bridge.processed.add(p);
	bridge.reserves = 357n;
	bridge.pot = 11n;
	bridge.mintedTotal = 400n;
	bridge.paidOut = 43n;
	bridge.pending = [
		{ id: "burn1", owner: "aa", amount: 12n, btcAddress: "bc1qaa", fee: 500n },
		{ id: "burn2", owner: "bb", amount: 31n, btcAddress: "bc1qbb", fee: 700n },
	]; // pending is FIFO — order is itself state, NOT reversed
	return { bridge, custody: { fundKey: "deadbeef", epoch: 0, excluded } };
}

test("viewRoot is independent of Map/Set insertion order", () => {
	assert.equal(viewRoot(makeView(false)), viewRoot(makeView(true)), "same logical state must hash identically");
});

test("serialize → deserialize → serialize is lossless (round-trips)", () => {
	const v = makeView();
	const once = serializeView(v);
	const back = deserializeView(once);
	const twice = serializeView(back);
	assert.deepEqual(twice, once, "round-trip changed the canonical state");
	assert.equal(viewRoot(back), viewRoot(v), "round-trip changed the root");
});

test("deserialize restores bigints / Maps / Sets as native types", () => {
	const back = deserializeView(serializeView(makeView()));
	assert.equal(back.bridge.gbtc.get("bb"), 250n);
	assert.equal(typeof back.bridge.reserves, "bigint");
	assert.ok(back.bridge.processed.has("dep1:0"));
	assert.equal(back.custody.excluded.get("ee"), 20);
	assert.equal(back.bridge.pot, 11n);
	assert.equal(back.bridge.pending[0].id, "burn1", "pending FIFO order preserved");
});

test("a single changed balance changes the root", () => {
	const a = makeView();
	const b = makeView();
	b.bridge.gbtc.set("aa", 101n); // +1 sat
	assert.notEqual(viewRoot(a), viewRoot(b));
});

test("empty view has a stable, defined root", () => {
	const empty: View = { bridge: emptyBridge(), custody: { fundKey: null, epoch: -1, excluded: new Map() } };
	assert.equal(viewRoot(empty), viewRoot(empty));
	assert.match(viewRoot(empty), /^[0-9a-f]{64}$/);
});
