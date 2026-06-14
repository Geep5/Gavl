/**
 * Genesis-free bootstrap over the mesh — the full payoff of adoption. Peer A has pruned BOTH its
 * ledger AND its anchor chain to a checkpoint, so it can only serve a recent suffix; genesis is
 * gone. A fresh peer B can't link that suffix to (grindable, absent) genesis, so it ADOPTS the
 * checkpoint's anchor as a trusted floor, links the suffix above it, authenticates the state via
 * the child anchor's appRoot, and converges to A's exact state — never having seen genesis.
 *
 *   node --test test/anchor-adopt-bootstrap.test.ts
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
import { PARAMS, K, STANDIN_VERIFIER, standinProver } from "./helpers.ts";

let depN = 0;

test("a fresh peer bootstraps genesis-free by adopting a pruned peer's checkpoint as a trusted floor", async () => {
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
	const mineOn = async (node: GavlNode): Promise<Anchor> => {
		const prev = node.anchorTip();
		const all = node.ledger.allWrites();
		const appRoot = prev ? viewRoot(viewAtAnchor(all, node.anchors!, prev.id)) : viewRoot(computeView([]));
		const a = (await mineAnchor({ prev, prevHeads: prev ? node.anchors!.headsAt(prev.id) : {}, producer: m, prover, heads: node.ledger.heads(), params: PARAMS, appRoot }))!;
		await node.submitAnchor(a);
		return a;
	};

	const acctA = mk();
	const acctB = mk();
	await oracle.postPrice(61000n, 0);
	await fund(acctA, 5000n);
	await fund(acctB, 5000n);
	await acctA.transfer(acctB.pubHex, 700n);
	await mineOn(A);
	await mineOn(A);
	await oracle.postPrice(64000n, 1);
	await acctA.transfer(acctB.pubHex, 50n);
	await mineOn(A);
	await mineOn(A);

	const fullView = computeView(A.ledger.allWrites());
	const fullRoot = A.ledger.stateRoot();

	// ── A checkpoints at a finalized anchor and PRUNES BOTH ledger AND anchor chain to it ──
	const ckptAnchor = A.anchors!.finalized(2)!; // has children (so its appRoot is committed)
	const ckptHeads = A.anchors!.headsAt(ckptAnchor.id);
	const ckptState = viewAtAnchor(A.ledger.allWrites(), A.anchors!, ckptAnchor.id);
	const snapshot: StoredSnapshot = { anchorId: ckptAnchor.id, height: ckptAnchor.height, heads: ckptHeads, state: serializeView(ckptState) };
	A.ledger.pruneBelow(ckptHeads);
	A.anchors!.prune(ckptAnchor.height); // ← the new part: A no longer holds genesis, only [ckpt..tip]
	assert.equal(A.anchors!.get(A.anchors!.chainTo()[0].id)!.id, ckptAnchor.id, "A's anchor chain now bottoms at the checkpoint, not genesis");
	assert.equal(A.ledger.stateRoot(), fullRoot, "prune preserved A's state");

	A.snapshotHeader = () => ({ anchorId: snapshot.anchorId, height: snapshot.height });
	A.fullSnapshot = () => snapshot;

	// ── Peer B: empty. It can NEVER reach genesis from A (pruned away) → must adopt ──
	const B = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	let bBase: View | undefined;
	let pending: StoredSnapshot | undefined;
	let seeded = false;
	const ingest = (snap: StoredSnapshot): boolean => {
		const anchor = B.anchors!.get(snap.anchorId);
		if (!anchor) {
			pending = snap; // anchor not adopted yet
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
	B.adoptFloor = (candidates) => {
		if (!pending || B.anchors!.tip() !== null) return false;
		const floor = candidates.find((a) => a.id === pending!.anchorId);
		if (!floor || rootOfHeads(pending.heads) !== floor.stateRoot) return false;
		try {
			B.anchors!.adopt(floor, pending.heads);
		} catch {
			return false;
		}
		return true;
	};
	B.onTip = () => {
		if (pending && ingest(pending)) B.advertise();
	};

	// ── Link them and let the protocol run ──
	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();

	assert.ok(seeded, "B bootstrapped genesis-free via adoption");
	assert.equal(B.anchors!.tip()!.id, A.anchors!.tip()!.id, "B's anchor tip matches A's");
	assert.equal(B.anchors!.get(ckptAnchor.id)!.id, ckptAnchor.id, "B adopted the checkpoint anchor as its floor");
	assert.equal(B.ledger.stateRoot(), fullRoot, "B's state matches A's full state");
	const bView = computeView(B.ledger.allWrites(), { base: bBase });
	assert.equal(viewRoot(bView), viewRoot(fullView), "B's folded view matches A's");
});
