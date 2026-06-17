/**
 * Autonomous co-signing triggers (the on-chain work-list) — gate #2/#4 plumbing.
 *
 * The committee drives all its authorizations off finalized state: a `bridge.claim`
 * asks it to mint a verified deposit, a `bridge.broadcast` marks a withdrawal in flight
 * (so it stops re-signing and watches for confirmation). This proves the FOLD that
 * turns those writes into the derived work-sets the daemon loop scans.
 *
 *   node --test test/custody-triggers.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView } from "../src/market/btc.ts";
import { pendingClaims, unsentWithdrawals, inFlightWithdrawals } from "../src/custody/bridge.ts";
import { PARAMS, K, TestFund } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const acct = () => new Account({ node, params: PARAMS, k: K, now }); // fresh identity each call
	// Committee-mint helper: announce one fund key, then mint quorum-signed deposits against it.
	const tf = new TestFund();
	let announced = false;
	const fund = async (depositor: string, amount: bigint, depositId?: string) => {
		if (!announced) {
			announced = true;
			await tf.announce(acct());
		}
		await tf.fund(acct(), depositor, amount, depositId);
	};
	return { node, acct, fund };
}
const bridge = (node: GavlNode) => computeView(node.ledger.allWrites()).bridge;

test("a claim is an outstanding mint request until its deposit is minted", async () => {
	const { node, acct, fund } = setup();
	await acct().claim("txA:0", "alicepub");
	await acct().claim("txB:1", "bobpub");
	assert.deepEqual(
		pendingClaims(bridge(node)).sort((a, b) => a.depositId.localeCompare(b.depositId)),
		[
			{ depositId: "txA:0", depositor: "alicepub" },
			{ depositId: "txB:1", depositor: "bobpub" },
		],
		"both claims are pending",
	);
	// the committee mints txA:0 → that claim is satisfied
	await fund("alicepub", 5000n, "txA:0");
	assert.deepEqual(pendingClaims(bridge(node)), [{ depositId: "txB:1", depositor: "bobpub" }], "minted claim drops; the other remains");
	// a duplicate claim doesn't double-count
	await acct().claim("txB:1", "bobpub");
	assert.equal(pendingClaims(bridge(node)).length, 1, "claim is idempotent by depositId");
});

test("a broadcast note moves a withdrawal from unsent → in-flight", async () => {
	const { node, acct, fund } = setup();
	const user = acct();
	await fund(user.pubHex, 10_000n, "dep:0"); // committee-mint to fund the user
	const burn = await user.withdraw(4000n, "tb1quserwithdrawaddrxxxxxxxxxxxxxxxxxxx");

	assert.deepEqual(
		unsentWithdrawals(bridge(node)).map((w) => w.id),
		[burn.id],
		"a fresh withdrawal is unsent",
	);
	assert.equal(inFlightWithdrawals(bridge(node)).length, 0, "nothing in flight yet");

	// the committee signs + broadcasts the payout, then announces the txid
	await acct().announceBroadcast(burn.id, "ab".repeat(32));
	assert.equal(unsentWithdrawals(bridge(node)).length, 0, "no longer unsent (stop re-signing)");
	assert.deepEqual(
		inFlightWithdrawals(bridge(node)).map((x) => ({ id: x.withdrawal.id, txid: x.txid })),
		[{ id: burn.id, txid: "ab".repeat(32) }],
		"now in flight, watching that txid for confirmation",
	);

	// a second note doesn't change the recorded txid (first wins)
	await acct().announceBroadcast(burn.id, "cd".repeat(32));
	assert.equal(inFlightWithdrawals(bridge(node))[0].txid, "ab".repeat(32), "broadcast is idempotent");
});
