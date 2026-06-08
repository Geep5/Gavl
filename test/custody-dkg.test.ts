/**
 * Distributed Key Generation (Phase 4) — the fund key is created with NO trusted
 * dealer: no party ever sees or holds the whole key, even at setup. The resulting
 * key signs Bitcoin-valid Taproot spends just like the dealer path.
 *
 *   node --test test/custody-dkg.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateFundKeyDKG, generateFundKey, thresholdSign, verify, quorumOf } from "../src/custody/threshold.ts";
import { fundAddress, taprootOutputKey, signWithdrawal, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { sha256 } from "@noble/hashes/sha2.js";

const m = (s: string) => sha256(new TextEncoder().encode(s));

test("DKG produces a working min-of-max fund with no dealer", () => {
	const key = generateFundKeyDKG(3, 5);
	assert.equal(Object.keys(key.shares).length, 5, "5 holders each get a share");
	assert.equal(key.min, 3);
	assert.equal(key.groupPubKey.length, 33, "a single group public key emerged");
});

test("a DKG quorum threshold-signs; sub-threshold cannot", () => {
	const key = generateFundKeyDKG(3, 5);
	const msg = m("dkg sign");
	assert.equal(verify(thresholdSign(msg, key.pub, quorumOf(key, 3)), msg, key.groupPubKey), true, "3-of-5 signs");
	assert.throws(() => thresholdSign(msg, key.pub, quorumOf(key, 2)), "2 of 3 cannot");
});

test("DKG key controls a real Bitcoin Taproot address (key-path spend valid)", () => {
	const key = generateFundKeyDKG(2, 3);
	const addr = fundAddress(key, "mainnet");
	assert.ok(addr.startsWith("bc1p"), "P2TR address");
	const sh = m("withdraw from DKG fund");
	const sig = signWithdrawal(key.pub, quorumOf(key, 2), sh);
	// the DKG group key is auto-tweaked (BIP-341 empty merkle root) → a proper
	// Taproot key-path spend that Bitcoin's BIP340 verifier accepts.
	assert.equal(verifyWithdrawal(sig, sh, taprootOutputKey(key.groupPubKey)), true, "Bitcoin accepts the DKG-quorum spend");
});

test("any quorum signs the same DKG key; the key is never reconstructed", () => {
	const key = generateFundKeyDKG(2, 4);
	const ids = Object.keys(key.shares);
	const sh = m("interchangeable quorums");
	for (const pair of [[0, 1], [1, 3], [0, 3]]) {
		const q = { [ids[pair[0]]]: key.shares[ids[pair[0]]], [ids[pair[1]]]: key.shares[ids[pair[1]]] };
		assert.equal(verify(thresholdSign(sh, key.pub, q), sh, key.groupPubKey), true, `quorum ${pair}`);
	}
	// Each signature was produced purely from per-holder shares — combineSecret is
	// never called, so the whole key is never assembled at any point.
});

test("DKG is independent of trusted-dealer setup (different key, different address)", () => {
	assert.notEqual(fundAddress(generateFundKeyDKG(3, 5)), fundAddress(generateFundKey(3, 5)), "independent setups → distinct funds");
	assert.notEqual(fundAddress(generateFundKeyDKG(3, 5)), fundAddress(generateFundKeyDKG(3, 5)), "two DKG runs → distinct funds");
});
