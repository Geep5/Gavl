/**
 * Replication floor — the durability guarantee that keeps RAM state alive across churn.
 *
 * State lives in RAM, committed into checkpoints. A checkpoint survives only as long as some
 * reachable node still holds it. Nodes advertise the checkpoint they hold (snapshot-have /
 * snapshot-offer) and count DISTINCT holders (deduped by peerKey, like the adoption quorum), so
 * the network can measure its replication factor: state survives the loss of up to factor-1
 * holders between handoffs. Under target, a node warns (and a capable archiver can pull-to-persist).
 *
 *   node --test test/replication.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import type { Connection } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { AnchorChain } from "../src/consensus/chain.ts";
import { mineAnchor } from "../src/consensus/anchor.ts";
import type { Anchor } from "../src/consensus/anchor.ts";
import { Account } from "../src/market/account.ts";
import { computeView, viewAtAnchor } from "../src/market/btc.ts";
import { serializeView, viewRoot } from "../src/market/state.ts";
import type { View } from "../src/market/btc.ts";
import type { StoredSnapshot } from "../src/store/store.ts";
import { oracleKeyPair } from "../src/market/oracle.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K, STANDIN_VERIFIER, standinProver, withGbtc } from "./helpers.ts";

/** Build a checkpoint + the full pre-prune chain (mirrors test/adopt-quorum.ts). */
async function buildCheckpoint(): Promise<{ snapshot: StoredSnapshot; full: { writes: any[]; anchors: Anchor[] } }> {
	const S = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	let t = 0;
	const now = () => ++t;
	const mk = (kp?: any) => new Account({ node: S, params: PARAMS, k: K, now, keypair: kp });
	const oracle = mk(oracleKeyPair());
	const balances: Record<string, bigint> = {};
	const fund = (a: Account, amt: bigint) => (balances[a.pubHex] = (balances[a.pubHex] ?? 0n) + amt);
	const base = () => withGbtc(computeView([]), balances);
	const m = generateKeyPair();
	const prover = standinProver(m);
	const mineOn = async (): Promise<void> => {
		const prev = S.anchorTip();
		const all = S.ledger.allWrites();
		const appRoot = prev ? viewRoot(viewAtAnchor(all, S.anchors!, prev.id, base())) : viewRoot(computeView([], { base: base() }));
		const a = (await mineAnchor({ prev, prevHeads: prev ? S.anchors!.headsAt(prev.id) : {}, producer: m, prover, heads: S.ledger.heads(), params: PARAMS, appRoot }))!;
		await S.submitAnchor(a);
	};
	const acctA = mk();
	const acctB = mk();
	await oracle.noop();
	fund(acctA, 5000n);
	fund(acctB, 5000n);
	await acctA.transfer(acctB.pubHex, 700n);
	await mineOn();
	await mineOn();
	await mineOn();

	const full = { writes: S.ledger.allWrites(), anchors: S.anchors!.chainTo() };
	const ckpt = S.anchors!.finalized(2)!;
	const heads = S.anchors!.headsAt(ckpt.id);
	const snapshot: StoredSnapshot = { anchorId: ckpt.id, height: ckpt.height, heads, state: serializeView(viewAtAnchor(full.writes, S.anchors!, ckpt.id, base())) };
	return { snapshot, full };
}

/** A node that durably holds `snapshot` (serves it + beacons it) — an archiver. */
async function holder(full: { writes: any[]; anchors: Anchor[] }, snapshot: StoredSnapshot): Promise<GavlNode> {
	const N = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, STANDIN_VERIFIER, { finalityDepth: 1 }));
	for (const w of full.writes) N.ledger.apply(w);
	for (const a of full.anchors) await N.anchors!.add(a);
	N.ledger.pruneBelow(snapshot.heads);
	N.anchors!.prune(snapshot.height);
	N.snapshotHeader = () => ({ anchorId: snapshot.anchorId, height: snapshot.height });
	N.fullSnapshot = () => snapshot;
	return N;
}

test("replication factor counts every distinct node holding the latest checkpoint", async () => {
	const { snapshot, full } = await buildCheckpoint();
	const A = await holder(full, snapshot);
	const B = await holder(full, snapshot);
	const C = await holder(full, snapshot);

	const net = new MemoryNetwork();
	net.link(A, B);
	net.link(B, C);
	net.link(A, C);
	await net.idle();

	for (const [name, n] of [["A", A], ["B", B], ["C", C]] as const)
		assert.equal(n.replicationFactor(snapshot.anchorId), 3, `${name} should see all 3 holders (self + 2 peers)`);
});

test("onUnderReplicated fires when holders fall below the target", async () => {
	const { snapshot, full } = await buildCheckpoint();
	const A = await holder(full, snapshot);
	const B = await holder(full, snapshot);
	A.replicationTarget = 3; // we want 3 holders, only 2 exist

	const warnings: { factor: number; target: number }[] = [];
	A.onUnderReplicated = (i) => warnings.push(i);

	const net = new MemoryNetwork();
	net.link(A, B);
	await net.idle();
	A.checkReplication();

	assert.ok(warnings.length > 0, "A should warn that the checkpoint is under-replicated");
	assert.equal(warnings[0].factor, 2, "self + B = 2 holders");
	assert.equal(warnings[0].target, 3);
});

test("a peer opening many connections counts once toward the replication factor (sybil guard)", async () => {
	const { snapshot, full } = await buildCheckpoint();
	const A = await holder(full, snapshot);

	// Two connections that both claim the same stable peerKey — one underlying node.
	const mkConn = (peerKey: string): Connection => {
		let onMsg: ((m: any) => void) | undefined;
		return {
			peerKey,
			send: () => {},
			onMessage: (h: (m: any) => void) => {
				onMsg = h;
			},
			onClose: () => {},
			close: () => {},
			// expose for the test to drive an inbound beacon
			_deliver: (m: any) => onMsg?.(m),
		} as unknown as Connection & { _deliver: (m: any) => void };
	};
	const c1 = mkConn("peerX") as Connection & { _deliver: (m: any) => void };
	const c2 = mkConn("peerX") as Connection & { _deliver: (m: any) => void };
	A.addPeer(c1);
	A.addPeer(c2);
	c1._deliver({ t: "snapshot-have", anchorId: snapshot.anchorId, height: snapshot.height });
	c2._deliver({ t: "snapshot-have", anchorId: snapshot.anchorId, height: snapshot.height });

	// self (A holds it) + the single distinct peer "peerX" = 2, not 3.
	assert.equal(A.replicationFactor(snapshot.anchorId), 2, "two connections from one peerKey count once");
});
