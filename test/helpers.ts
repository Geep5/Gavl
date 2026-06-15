/** Shared test fixtures: low-difficulty params and a chain builder. */

import { Writer } from "../src/chain/writer.ts";
import type { ChainParams, Write } from "../src/chain/writer.ts";
import { HashVdf } from "../src/pot/hash-vdf.ts";
import { Plot } from "../src/pos/space.ts";
import { StandinSpaceProver, StandinSpaceVerifier } from "../src/consensus/space.ts";
import type { SpaceProver } from "../src/consensus/space.ts";
import type { KeyPair } from "../src/det/ed25519.ts";
import { computeView, cloneView } from "../src/market/btc.ts";
import type { View } from "../src/market/btc.ts";

/** A fold base carrying a market price — the test stand-in for a relayed Pyth update. Every market is
 *  now a Pyth market: the only way a price enters consensus is a Wormhole-guardian-attested update,
 *  which a unit test can't forge (it needs 13/19 real guardian signatures). The real verify+fold path
 *  is covered by test/pyth.test.ts against a captured live update; the economic tests just need a
 *  mark in the view, so they seed it directly as the fold's resume base. `at` drives mark staleness. */
export function priceBase(price: bigint, seq = 0, at = 0): View {
	const v = computeView([]);
	v.market = { price, expo: 0, seq, at };
	return v;
}

/** Clone a view with a changed market price — for tests that move the mark mid-stream (open at one
 *  price, settle at another). Fold the next write segment with `{ base: repriced(view, p) }`. */
export function repriced(view: View, price: bigint, seq = view.market.seq + 1, at = view.market.at): View {
	const v = cloneView(view);
	v.market = { price, expo: 0, seq, at };
	return v;
}

/** Low difficulty so multi-write, multi-node tests stay quick. */
export const PARAMS: ChainParams = {
	vdf: new HashVdf(),
	difficulty: 20n,
	dcf: 1n << 20n,
	floorIters: 500n,
};

export const K = 11; // 2,048-leaf plot
const ROOT0 = "00".repeat(32);

/** Build an identity and produce `n` valid writes in sequence. */
export async function makeChain(n: number, params: ChainParams = PARAMS, k: number = K): Promise<{ writer: Writer; writes: Write[] }> {
	const writer = new Writer({ k, params });
	const writes: Write[] = [];
	let prev: string | null = null;
	for (let i = 0; i < n; i++) {
		const w = await writer.write({ prev, seq: i, stateRoot: ROOT0, payload: { i }, ts: i });
		writes.push(w);
		prev = w.id;
	}
	return { writer, writes };
}

/** Shared stand-in space backend for fast anchor tests (no plotting). */
export const STANDIN_VERIFIER = new StandinSpaceVerifier();
export function standinProver(keypair: KeyPair, k: number = K): SpaceProver {
	return new StandinSpaceProver(new Plot(keypair.publicKey, k));
}

export async function waitFor(pred: () => boolean, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`waitFor: condition not met within ${ms}ms`);
}
