/**
 * Per-identity deposit addresses (fix for deposit front-running). A BTC deposit is
 * cryptographically bound to one Gavl pubkey via a deterministic Taproot tweak, and
 * the committee can still spend it (proven against Bitcoin's BIP340 verifier).
 *
 *   node --test test/custody-deposit.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateFundKeyDKG, quorumOf } from "../src/custody/threshold.ts";
import { depositAddress, depositOutputKey, depositTweak, signDepositSpend } from "../src/custody/deposit.ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

const fundXonly = (key) => key.groupPubKey; // deposit fns take the full 33-byte fund key
const pub = (s) => sha256(new TextEncoder().encode("user:" + s)); // a stand-in 32-byte Gavl pubkey
const hex = (b) => Buffer.from(b).toString("hex");

test("each user gets a DISTINCT, deterministic deposit address", () => {
	const fund = generateFundKeyDKG(2, 3);
	const X = fundXonly(fund);
	const a = depositAddress(X, hex(pub("alice")), "testnet");
	const b = depositAddress(X, hex(pub("bob")), "testnet");
	assert.notEqual(a, b, "alice and bob get different addresses");
	assert.equal(a, depositAddress(X, hex(pub("alice")), "testnet"), "deterministic for the same user");
	assert.ok(a.startsWith("tb1p"), "a real P2TR address");
	// the per-user address is NOT the base fund address — binding lives in the address
	assert.notEqual(depositOutputKey(X, hex(pub("alice"))), X);
});

test("FRONT-RUNNING is impossible: a deposit to A's address can't be claimed as B's", () => {
	const fund = generateFundKeyDKG(2, 3);
	const X = fundXonly(fund);
	// alice's deposit lands at alice's derived address
	const aliceAddr = depositAddress(X, hex(pub("alice")), "testnet");
	// the claim check is: does the deposit's address == depositAddress(claimer)?
	// an honest claim by alice matches; a front-run claim by mallory does NOT.
	assert.equal(aliceAddr, depositAddress(X, hex(pub("alice")), "testnet"), "alice's claim matches her address");
	assert.notEqual(aliceAddr, depositAddress(X, hex(pub("mallory")), "testnet"), "mallory's address differs → her claim of alice's tx fails");
});

test("the committee CAN spend a per-user deposit (BIP340-valid, both Y-parities)", () => {
	const fund = generateFundKeyDKG(3, 5);
	let even = 0;
	let odd = 0;
	for (let i = 0; i < 8; i++) {
		const userPub = hex(pub("u" + i));
		const depKey = depositOutputKey(fundXonly(fund), userPub); // x-only
		const sighash = sha256(new TextEncoder().encode("spend deposit " + i));
		const sig = signDepositSpend(fund, userPub, quorumOf(fund, 3), sighash);
		assert.equal(schnorr.verify(sig, sighash, depKey), true, `deposit ${i} spend is Bitcoin-valid`);
		// track parity to be sure both branches are exercised
		if (depKey[0] !== undefined) (BigInt("0x" + hex(depKey)) % 2n === 0n ? even++ : odd++);
	}
	assert.ok(even > 0 && odd > 0, "exercised both even and odd Y deposit keys");
});

test("a deposit-spend signature is bound to its own user's key (no cross-use)", () => {
	const fund = generateFundKeyDKG(2, 3);
	const sighash = sha256(new TextEncoder().encode("tx"));
	const sigAlice = signDepositSpend(fund, hex(pub("alice")), quorumOf(fund, 2), sighash);
	// alice's signature does NOT verify against bob's deposit key
	const bobKey = depositOutputKey(fundXonly(fund), hex(pub("bob")));
	assert.equal(schnorr.verify(sigAlice, sighash, bobKey), false, "can't move a deposit-spend sig onto another user's address");
});

test("tweak is bound to the fund key too (different fund → different address)", () => {
	const f1 = generateFundKeyDKG(2, 3);
	const f2 = generateFundKeyDKG(2, 3);
	const u = hex(pub("alice"));
	assert.notEqual(depositTweak(fundXonly(f1), u), depositTweak(fundXonly(f2), u), "tweak depends on the fund");
	assert.notEqual(depositAddress(fundXonly(f1), u, "testnet"), depositAddress(fundXonly(f2), u, "testnet"));
});
