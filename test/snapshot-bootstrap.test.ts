/**
 * Trustless new-peer bootstrap over the mesh — the payoff of the whole effort. A peer A
 * that has PRUNED its history to a checkpoint serves a fresh, empty peer B the committed
 * STATE (a snapshot) instead of replaying writes from 0. B authenticates it against the
 * anchor chain's appRoot, seeds, then pulls only the post-checkpoint tail — and converges
 * to A's exact state having never seen the pre-checkpoint writes.
 *
 *   node --test test/snapshot-bootstrap.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger, rootOfHeads } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { Account } from "../src/market/account.ts";
import { computeView, viewAtAnchor } from "../src/market/btc.ts";
import { serializeView, deserializeView, viewRoot } from "../src/market/state.ts";
import type { View } from "../src/market/btc.ts";
import type { StoredSnapshot } from "../src/store/store.ts";
import { oracleKeyPair, bridgeKeyPair } from "../src/market/oracle.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver , setupMarket } from "./helpers.ts";

let depN = 0;

test("a fresh peer bootstraps from a pruned peer's checkpoint and converges without pre-checkpoint history", async () => {
	// ── Build peer A: writes + an anchor chain that buries them to finality ──
	const A = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node: A, params: PARAMS, k: K, now, keypair: kp });
	const oracle = mk(oracleKeyPair());
	const attestor = mk(bridgeKeyPair());
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);

	const m = generateKeyPair();
	const prover = standinProver(m);
	const mineOn = async (node: GavlNode) => {
		const prev = node.anchorTip();
		const all = node.ledger.allWrites();
		const appRoot = prev ? viewRoot(viewAtAnchor(all, node.anchors!, prev.id)) : viewRoot(computeView([]));
		const a = (await mineAnchor({ prev, prevHeads: prev ? node.anchors!.headsAt(prev.id) : {}, producer: m, prover, heads: node.ledger.heads(), params: PARAMS, appRoot }))!;
		await node.submitAnchor(a);
		return a;
	};

	const acctA = mk();
	const acctB = mk();
	await setupMarket(oracle, 61000n);
	await fund(acctA, 5000n);
	await fund(acctB, 5000n);
	await acctA.transfer(acctB.pubHex, 700n);
	await mineOn(A); // a0 buries round 1
	const F = await mineOn(A); // a1 → finalized(1) = a0 once a1 is tip; F's child exists
	await oracle.report(64000n, 1);
	await acctA.transfer(acctB.pubHex, 50n);
	await mineOn(A); // a2 (so a1 is now finalized and has a child)
	await mineOn(A); // a3

	const fullView = computeView(A.ledger.allWrites());
	const fullRoot = A.ledger.stateRoot();

	// ── A takes a checkpoint at a finalized anchor and PRUNES to it ──
	const ckptAnchor = A.anchors!.finalized(2)!; // a1 (2 deep from a3) — has children a2,a3
	const ckptHeads = A.anchors!.headsAt(ckptAnchor.id);
	const ckptState = viewAtAnchor(A.ledger.allWrites(), A.anchors!, ckptAnchor.id);
	const snapshot: StoredSnapshot = { anchorId: ckptAnchor.id, height: ckptAnchor.height, heads: ckptHeads, state: serializeView(ckptState) };
	const preCount = A.ledger.allWrites().length;
	A.ledger.pruneBelow(ckptHeads); // A now holds ONLY post-checkpoint writes
	assert.ok(A.ledger.allWrites().length < preCount, "A actually pruned history");
	assert.equal(A.ledger.stateRoot(), fullRoot, "prune preserved A's heads/state");

	// Wire A to offer + serve the checkpoint.
	A.snapshotHeader = () => ({ anchorId: snapshot.anchorId, height: snapshot.height });
	A.fullSnapshot = () => snapshot;

	// ── Peer B: empty. Verify a pulled checkpoint against ITS synced anchors, then seed ──
	const B = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	let bBase: View | undefined;
	let pending: StoredSnapshot | undefined;
	let seeded = false;
	const ingest = (snap: StoredSnapshot): boolean => {
		const anchor = B.anchors!.get(snap.anchorId);
		if (!anchor) {
			pending = snap;
			return false;
		}
		if (rootOfHeads(snap.heads) !== anchor.stateRoot) return false;
		const child = B.anchors!.chainTo().find((a) => a.prev === snap.anchorId);
		if (!child) {
			pending = snap;
			return false;
		}
		if (viewRoot(deserializeView(snap.state)) !== child.appRoot) return false;
		B.ledger.seedCheckpoint(snap.heads);
		bBase = deserializeView(snap.state);
		seeded = true;
		pending = undefined;
		return true;
	};
	B.wantSnapshot = () => B.ledger.summary().writers === 0 && !seeded;
	B.onSnapshot = (snap) => ingest(snap);
	B.onTip = () => {
		if (pending && ingest(pending)) B.advertise();
	};

	// ── Link them and let the protocol run ──
	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();

	assert.ok(seeded, "B bootstrapped from the checkpoint");
	// B reached A's exact state...
	assert.equal(B.ledger.stateRoot(), fullRoot, "B's stateRoot matches A's full state");
	const bView = computeView(B.ledger.allWrites(), { base: bBase });
	assert.equal(viewRoot(bView), viewRoot(fullView), "B's folded view matches A's full view");
	// ...without ever holding the pre-checkpoint writes: B's chains start ABOVE the checkpoint.
	assert.ok(B.ledger.allWrites().length < preCount, "B holds fewer writes than full history — it skipped the pre-checkpoint ones");
	for (const writer of Object.keys(ckptHeads)) {
		assert.equal(B.ledger.writesFrom(writer, 0).length, A.ledger.writesFrom(writer, 0).length, "B holds exactly the post-checkpoint tail A still has");
	}
});
