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
import { mintFromDeposit } from "../src/custody/bridge.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { depositAttestationDigest } from "../src/custody/attestation.ts";
import { toHex } from "../src/det/canonical.ts";
import type { Account } from "../src/market/account.ts";

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

/** Seed gBTC balances directly into a fold base. Minting is committee-gated now (a threshold sig
 *  over the group key — see TestFund), but economic/consensus tests only need balances to EXIST,
 *  not to exercise the mint authorization, so we put them straight in the resume base (1:1 backed,
 *  so `marketConserved` holds). Use TestFund when the test is actually about mint authorization. */
export function withGbtc(base: View, balances: Record<string, bigint>): View {
	let i = 0;
	for (const [pub, amt] of Object.entries(balances)) mintFromDeposit(base.bridge, { depositId: "seed:" + i++, depositor: pub, amount: amt }, 0);
	return base;
}

/** A test committee fund: a DKG'd group key you announce on-chain, then mint against with a
 *  threshold signature — the real authorization path now that the single-attestor fallback is gone.
 *  `announce()` must fold BEFORE any `fund()` deposit (it carries the earliest ts when produced first). */
export class TestFund {
	readonly key: FundKey;
	private n = 0;
	constructor(min = 2, max = 3) {
		this.key = generateFundKeyDKG(min, max);
	}
	get groupKeyHex(): string {
		return toHex(this.key.groupPubKey);
	}
	/** Announce the group key on-chain via `announcer` (any account; first-write-wins). */
	announce(announcer: Account, epoch = 1) {
		return announcer.announceFund(this.groupKeyHex, epoch);
	}
	/** A quorum-signed `bridge.deposit` minting `amount` to `depositor`, relayed by `via` (any node).
	 *  `depositId` defaults to a fresh outpoint; pass one to satisfy a specific claim. */
	fund(via: Account, depositor: string, amount: bigint, depositId = "tf" + this.n++ + ":0") {
		const sig = toHex(thresholdSign(depositAttestationDigest({ depositId, depositor, amount }), this.key.pub, quorumOf(this.key, this.key.min)));
		return via.attestDeposit(depositId, depositor, amount, sig);
	}
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
