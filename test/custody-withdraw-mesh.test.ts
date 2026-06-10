/**
 * Distributed WITHDRAWAL over the mesh (gate #2) — a committee quorum builds the
 * same withdrawal tx and co-signs it through the ceremony (each node holding only
 * its own share), converging on the identical broadcastable signed tx.
 *
 *   node --test test/custody-withdraw-mesh.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { buildWithdrawalTx } from "../src/custody/btctx.ts";
import { signWithdrawalDistributed } from "../src/custody/withdraw-ceremony.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { PARAMS } from "./helpers.ts";

const RECIPIENT = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

test("a quorum co-signs a withdrawal tx over the mesh → identical signed tx, no gathered shares", async () => {
	const ids = ["a", "b", "c", "d", "e"];
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);

	// distributed DKG: each node keeps only its own share
	const dkg = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund", selfId: id, participants: ids, min: 3 }));
	const ds = dkg.map((c) => c.start());
	await net.idle();
	const keys = await Promise.all(ds);
	const groupPubKey = keys[0].groupPubKey;
	const pub = keys[0].pub;

	// every quorum member builds the SAME unsigned withdrawal (deterministic) and
	// co-signs it with ONLY its own share — never gathered into one structure.
	const quorum = ["a", "b", "c"];
	const fundView = { groupPubKey, pub, shares: {}, min: 3, max: 5 } as FundKey;
	const mkUnsigned = () => buildWithdrawalTx(fundView, { inputs: [{ txid: "ab".repeat(32), index: 0, amount: 500_000n }], outputs: [{ address: RECIPIENT, amount: 495_000n }] });

	const signed = quorum.map((id) =>
		signWithdrawalDistributed(mkUnsigned(), { node: nodes[id], signIdBase: "wd-1", selfId: id, quorum, pub, groupPubKey, share: keys[ids.indexOf(id)].share }),
	);
	await net.idle();
	const results = await Promise.all(signed);

	// all members produced the IDENTICAL finalized tx (they converged on one signature)
	assert.equal(results[0].txid.length, 64);
	for (const r of results) {
		assert.equal(r.txid, results[0].txid, "same txid on every member");
		assert.equal(r.hex, results[0].hex, "byte-identical signed tx");
	}
	assert.ok(/^[0-9a-f]+$/.test(results[0].hex), "valid tx hex");
});

test("a per-user DEPOSIT input is co-signed distributedly (tweaked) — base + deposit in one tx", async () => {
	const ids = ["x", "y", "z"];
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);
	const dkg = ids.map((id) => new DkgCoordinator(nodes[id], { session: "f", selfId: id, participants: ids, min: 2 }));
	const ds = dkg.map((c) => c.start());
	await net.idle();
	const keys = await Promise.all(ds);
	const groupPubKey = keys[0].groupPubKey;
	const pub = keys[0].pub;
	const fundView = { groupPubKey, pub, shares: {}, min: 2, max: 3 } as FundKey;

	const depositor = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"; // a sample user pubkey
	// one base-fund input + one per-user deposit input, in a single withdrawal
	const mkUnsigned = () =>
		buildWithdrawalTx(fundView, {
			inputs: [
				{ txid: "aa".repeat(32), index: 0, amount: 100_000n }, // base
				{ txid: "bb".repeat(32), index: 1, amount: 150_000n, owner: depositor }, // per-user deposit
			],
			outputs: [{ address: RECIPIENT, amount: 245_000n }],
		});

	const quorum = ["x", "y"];
	const signed = quorum.map((id) => signWithdrawalDistributed(mkUnsigned(), { node: nodes[id], signIdBase: "wd", selfId: id, quorum, pub, groupPubKey, share: keys[ids.indexOf(id)].share }));
	await net.idle();
	const results = await Promise.all(signed);
	// both committee members converge on the identical signed tx (base + deposit inputs)
	assert.equal(results[0].txid, results[1].txid, "same txid");
	assert.equal(results[0].hex, results[1].hex, "byte-identical signed tx (base + deposit)");
	assert.equal(results[0].txid.length, 64);
});
