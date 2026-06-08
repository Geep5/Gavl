/**
 * Bitcoin Taproot binding — the FROST fund key becomes a real P2TR address, and a
 * quorum produces a withdrawal signature Bitcoin's own BIP340 verifier accepts.
 *
 *   node --test test/custody-bitcoin.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateFundKey, quorumOf } from "../src/custody/threshold.ts";
import { taprootOutputKey, taprootAddress, taprootScriptPubKey, fundAddress, signWithdrawal, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { sha256 } from "@noble/hashes/sha2.js";

test("bech32m P2TR encoding matches the BIP341 test vector", () => {
	const outKey = Uint8Array.from(Buffer.from("a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c", "hex"));
	assert.equal(taprootAddress(outKey, "mainnet"), "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr");
});

test("fund key → a real Taproot address (deterministic, network-aware)", () => {
	const key = generateFundKey(2, 3);
	const addr = fundAddress(key, "mainnet");
	assert.ok(addr.startsWith("bc1p"), "mainnet P2TR address");
	assert.equal(addr, fundAddress(key, "mainnet"), "deterministic for the same key");
	assert.ok(fundAddress(key, "testnet").startsWith("tb1p"), "testnet HRP");
	// scriptPubKey is OP_1 push32 <key>
	const spk = taprootScriptPubKey(taprootOutputKey(key.groupPubKey));
	assert.equal(spk.length, 34);
	assert.equal(spk[0], 0x51); // OP_1
	assert.equal(spk[1], 0x20); // push 32
});

test("a quorum's withdrawal signature is BITCOIN-VALID (BIP340)", () => {
	const key = generateFundKey(2, 3); // 2-of-3 fund
	const xonly = taprootOutputKey(key.groupPubKey);
	const sighash = sha256(new TextEncoder().encode("spend fund UTXO → user payout")); // stand-in 32-byte sighash

	const sig = signWithdrawal(key.pub, quorumOf(key, 2), sighash);
	assert.equal(sig.length, 64, "64-byte Schnorr signature");
	// THE proof: Bitcoin's own BIP340 verifier accepts it against the fund's x-only key
	assert.equal(verifyWithdrawal(sig, sighash, xonly), true, "Bitcoin would accept this spend");
});

test("the signature is bound to the exact withdrawal (no replay)", () => {
	const key = generateFundKey(3, 5);
	const xonly = taprootOutputKey(key.groupPubKey);
	const realSighash = sha256(new TextEncoder().encode("pay alice 0.5 BTC"));
	const sig = signWithdrawal(key.pub, quorumOf(key, 3), realSighash);
	assert.equal(verifyWithdrawal(sig, realSighash, xonly), true);
	const evilSighash = sha256(new TextEncoder().encode("pay mallory 5 BTC"));
	assert.equal(verifyWithdrawal(sig, evilSighash, xonly), false, "can't move the sig onto a different tx");
});

test("below threshold cannot produce a spendable signature", () => {
	const key = generateFundKey(3, 5); // need 3
	const sighash = sha256(new TextEncoder().encode("forged withdrawal"));
	assert.throws(() => signWithdrawal(key.pub, quorumOf(key, 2), sighash), "2-of-3... 2-of-5 short of 3 can't sign");
});
