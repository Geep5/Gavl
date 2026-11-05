/**
 * THE critical equivalence for the order board: the state an anchor commits to is a pure function
 * of the writes it certifies and its height — independent of the fold path. A node that folded all
 * history in one pass, a node that resumed from a checkpoint (its committed state + only the writes
 * above it), and a node that checkpointed at EVERY anchor all reach the identical viewRoot at every
 * anchor — including across height-timed transitions (proof deadline, offer expiry) that fire
 * between checkpoints. This is what makes "never replay from 0" sound for the order board.
 *
 *   node --test test/orders-determinism.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";

import { Ledger } from "../src/ledger/ledger.ts";
import type { Heads } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import type { Write } from "../src/chain/writer.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { sha256Hex, toHex } from "../src/det/canonical.ts";
import { viewAtAnchor, PROOF_WINDOW } from "../src/market/fold.ts";
import { emptyView, viewRoot } from "../src/market/state.ts";
import type { View } from "../src/market/state.ts";
import type { Op } from "../src/market/ops.ts";
import { Account, PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

const xkey = (): string => toHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const proof = (chain: "bitcoin" | "litecoin") => ({ chain, net: "regtest" as const, pubkey: xkey(), utxos: [{ txid: sha256Hex(xkey()), vout: 0, value: "5000000" }], sig: "22".repeat(64) });

test("one pass, checkpoint+resume, and a checkpoint at every anchor commit the identical order board", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	const chain = new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 });
	let t = 0;
	const now = () => ++t;
	const kp = generateKeyPair();
	const prover = standinProver(kp);
	const anchors: Anchor[] = [];
	const mine = async (): Promise<Anchor> => {
		const prev = chain.tip();
		const a = (await mineAnchor({ prev, prevHeads: prev ? chain.headsAt(prev.id) : {}, producer: kp, prover, heads: node.ledger.heads(), params: PARAMS }))!;
		assert.equal((await chain.add(a)).ok, true);
		anchors.push(a);
		return a;
	};
	const maker = new Account({ node, params: PARAMS, k: K, now });
	const t1 = new Account({ node, params: PARAMS, k: K, now });
	const t2 = new Account({ node, params: PARAMS, k: K, now });
	const op = (a: Account, o: Op): Promise<Write> => a.postOp(o);

	await mine(); // genesis
	const short = await op(maker, { kind: "offer.post", give: { chain: "bitcoin", amount: 1_000_000n }, want: { chain: "litecoin", amount: 40_000_000n }, minFill: 100_000n, expiresIn: 8 });
	const long = await op(maker, { kind: "offer.post", give: { chain: "litecoin", amount: 50_000_000n }, want: { chain: "bitcoin", amount: 1_200_000n }, minFill: 5_000_000n, expiresIn: 500 });
	await mine();
	const m1 = await op(t1, { kind: "offer.take", offerId: short.id, fill: 300_000n, hash: sha256Hex("s1"), takerKey: xkey() });
	const m2 = await op(t2, { kind: "offer.take", offerId: short.id, fill: 200_000n, hash: sha256Hex("s2"), takerKey: xkey() });
	const m3 = await op(t2, { kind: "offer.take", offerId: long.id, fill: 10_000_000n, hash: sha256Hex("s3"), takerKey: xkey() });
	const takeAnchor = await mine();
	await op(t1, { kind: "swap.proof", matchId: m1.id, makerKey: null, proof: proof("litecoin") });
	await op(maker, { kind: "swap.proof", matchId: m1.id, makerKey: xkey(), proof: proof("bitcoin") });
	await op(t2, { kind: "swap.proof", matchId: m2.id, makerKey: null, proof: proof("litecoin") }); // the maker never proves m2
	await op(t2, { kind: "swap.proof", matchId: m3.id, makerKey: null, proof: proof("bitcoin") });
	await op(maker, { kind: "swap.proof", matchId: m3.id, makerKey: xkey(), proof: proof("litecoin") });
	await mine();
	await op(t1, { kind: "swap.locked", matchId: m1.id, txid: sha256Hex("lock1"), vout: 0 });
	await op(maker, { kind: "swap.abort", matchId: m3.id }); // taker never locked m3
	await mine();
	await op(maker, { kind: "swap.locked", matchId: m1.id, txid: sha256Hex("lock2"), vout: 1 });
	await op(maker, { kind: "offer.cancel", offerId: long.id });
	// Ride past m2's proof deadline and `short`'s expiry with plain anchors (no writes) in between.
	while (chain.tip()!.height <= takeAnchor.height + PROOF_WINDOW + 2) await mine();
	await op(t1, { kind: "offer.take", offerId: short.id, fill: 100_000n, hash: sha256Hex("s4"), takerKey: xkey() }); // `short` has expired → no-op
	await mine();
	await mine();

	const all = node.ledger.allWrites();
	const full = (a: Anchor): View => viewAtAnchor(all, chain, a.id);
	const final = anchors[anchors.length - 1];
	const end = full(final);

	// The script did what it says (so the equivalence below covers real transitions).
	assert.equal(end.matches.get(m1.id)!.status, "escrow");
	assert.ok(end.matches.get(m1.id)!.makerLock && end.matches.get(m1.id)!.takerLock);
	assert.deepEqual(end.matches.get(m2.id)!.cancelled, { at: takeAnchor.height + PROOF_WINDOW + 1, reason: "noProof" });
	assert.equal(end.matches.get(m3.id)!.cancelled!.reason, "abort");
	assert.equal(end.offers.size, 0, "short expired, long cancelled");
	assert.equal(end.matches.size, 3, "the late take did nothing");

	// A pruned node: checkpoint at c, keep c's state + only the writes above c's certified heads.
	const above = (heads: Heads) => all.filter((w) => heads[w.writer] === undefined || w.seq > heads[w.writer].seq);
	for (const c of anchors) {
		const base = full(c);
		const tail = above(chain.headsAt(c.id));
		for (const a of anchors.filter((x) => x.height >= c.height)) {
			assert.equal(viewRoot(viewAtAnchor(tail, chain, a.id, base)), viewRoot(full(a)), `checkpoint ${c.height} → anchor ${a.height}`);
		}
	}

	// A node that checkpoints at EVERY anchor, folding only each anchor's new writes onto the last state.
	let base: View | undefined;
	let prevHeads: Heads = {};
	for (const a of anchors) {
		const heads = chain.headsAt(a.id);
		base = viewAtAnchor(above(prevHeads).filter((w) => heads[w.writer] !== undefined && w.seq <= heads[w.writer].seq), chain, a.id, base);
		assert.equal(viewRoot(base), viewRoot(full(a)), `chained checkpoints at anchor ${a.height}`);
		prevHeads = heads;
	}
	assert.notEqual(viewRoot(end), viewRoot(emptyView()), "non-trivial final state");
});
