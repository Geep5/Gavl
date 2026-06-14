/**
 * Adoption quorum — the hardening on genesis-free bootstrap. Adopting a checkpoint as a trusted
 * floor is a weak-subjectivity step, so a fresh node requires the SAME checkpoint from N DISTINCT
 * peers before it will adopt — a lone (or sybil) peer can't feed a fabricated floor. With quorum
 * met (two independent peers agree) the node bootstraps; with only one peer it refuses and stays
 * empty.
 *
 *   node --test test/adopt-quorum.test.ts
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

/** Build a server: writes + an anchor chain, then prune BOTH to a checkpoint (genesis gone).
 *  Returns the pruned node, the checkpoint snapshot, and the full pre-prune view for comparison. */
async function buildServer(): Promise<{ snapshot: StoredSnapshot; full: { writes: any[]; anchors: Anchor[]; root: string; view: View } }> {
	const S = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node: S, params: PARAMS, k: K, now, keypair: kp });
	const oracle = mk(oracleKeyPair());
	const attestor = mk(bridgeKeyPair());
	const fund = (a: Account, amt: bigint) => attestor.attestDeposit("dep" + depN++ + ":0", a.pubHex, amt);
	const m = generateKeyPair();
	const prover = standinProver(m);
	const mineOn = async (): Promise<void> => {
		const prev = S.anchorTip();
		const all = S.ledger.allWrites();
		const appRoot = prev ? viewRoot(viewAtAnchor(all, S.anchors!, prev.id)) : viewRoot(computeView([]));
		const a = (await mineAnchor({ prev, prevHeads: prev ? S.anchors!.headsAt(prev.id) : {}, producer: m, prover, heads: S.ledger.heads(), params: PARAMS, appRoot }))!;
		await S.submitAnchor(a);
	};
	const acctA = mk();
	const acctB = mk();
	await oracle.postPrice(61000n, 0);
	await fund(acctA, 5000n);
	await fund(acctB, 5000n);
	await acctA.transfer(acctB.pubHex, 700n);
	await mineOn();
	await mineOn();
	await acctA.transfer(acctB.pubHex, 50n);
	await mineOn();
	await mineOn();

	const full = { writes: S.ledger.allWrites(), anchors: S.anchors!.chainTo(), root: S.ledger.stateRoot(), view: computeView(S.ledger.allWrites()) };
	const ckpt = S.anchors!.finalized(2)!;
	const heads = S.anchors!.headsAt(ckpt.id);
	const snapshot: StoredSnapshot = { anchorId: ckpt.id, height: ckpt.height, heads, state: serializeView(viewAtAnchor(full.writes, S.anchors!, ckpt.id)) };
	return { snapshot, full };
}

/** A pruned server node that serves `snapshot` + the suffix above it (genesis dropped). */
async function server(full: { writes: any[]; anchors: Anchor[] }, snapshot: StoredSnapshot): Promise<GavlNode> {
	const N = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	for (const w of full.writes) N.ledger.apply(w);
	for (const a of full.anchors) await N.anchors!.add(a);
	N.ledger.pruneBelow(snapshot.heads);
	N.anchors!.prune(snapshot.height);
	N.snapshotHeader = () => ({ anchorId: snapshot.anchorId, height: snapshot.height });
	N.fullSnapshot = () => snapshot;
	return N;
}

/** A fresh node that adopts only a quorum-approved floor (mirrors the daemon wiring). */
function freshNode(quorum: number): { node: GavlNode; seeded: () => boolean } {
	const B = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	B.snapshotQuorum = quorum;
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
		seeded = true;
		pending = undefined;
		return true;
	};
	B.wantSnapshot = () => B.ledger.summary().writers === 0 && !seeded;
	B.onSnapshot = (snap) => ingest(snap);
	B.adoptFloor = (candidates) => {
		if (!pending || B.anchors!.tip() !== null || !B.snapshotQuorumMet(pending.anchorId)) return false;
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
	return { node: B, seeded: () => seeded };
}

test("a fresh node adopts only when a QUORUM of distinct peers offers the same checkpoint", async () => {
	const { snapshot, full } = await buildServer();
	const A1 = await server(full, snapshot);
	const A2 = await server(full, snapshot); // an independent peer serving the identical checkpoint

	const { node: B, seeded } = freshNode(2); // require two distinct peers to agree
	const net = new MemoryNetwork();
	net.link(A1, B);
	net.link(A2, B);
	await net.idle();

	assert.ok(seeded(), "B bootstrapped once two peers vouched for the checkpoint");
	assert.equal(B.ledger.stateRoot(), full.root, "B reached the servers' full state");
	assert.equal(viewRoot(computeView(B.ledger.allWrites(), { base: deserializeView(snapshot.state) })), viewRoot(full.view), "B's view matches");
});

test("a fresh node REFUSES to adopt on a single peer's say-so when quorum is 2", async () => {
	const { snapshot, full } = await buildServer();
	const A1 = await server(full, snapshot);

	const { node: B, seeded } = freshNode(2);
	const net = new MemoryNetwork();
	net.link(A1, B); // only ONE peer
	await net.idle();

	assert.ok(!seeded(), "B did not seed — one peer is below quorum");
	assert.equal(B.anchors!.tip(), null, "B installed no floor (adoption refused)");
	assert.ok(!B.snapshotQuorumMet(snapshot.anchorId), "the checkpoint never reached quorum");
});
