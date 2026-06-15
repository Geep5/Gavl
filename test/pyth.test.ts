/**
 * Pyth update verification — a market with no designated reporter. The fold verifies that a real
 * 2/3+1 quorum of the Wormhole guardian set signed the price's Merkle root, then extracts the price
 * — so ANYONE can relay the update and a forged one simply fails. Tested against a captured LIVE
 * Pyth BTC/USD update (fixtures/pyth-btc-update.json): real guardian signatures, real Merkle proof.
 *
 *   node --test test/pyth.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { verifyPythUpdate, WORMHOLE_GUARDIANS } from "../src/market/pyth.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, mark } from "../src/market/btc.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K } from "./helpers.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/pyth-btc-update.json", import.meta.url), "utf8"));

test("verifies a real Pyth BTC/USD update — guardian quorum + Merkle proof", () => {
	const prices = verifyPythUpdate(fx.blob);
	assert.ok(prices.length > 0, "a valid update yields at least one verified price");
	const btc = prices.find((p) => p.feedId === fx.expected.feedId);
	assert.ok(btc, "the BTC/USD feed is present");
	assert.equal(btc!.price, BigInt(fx.expected.price), "decoded price matches the live value");
	assert.equal(btc!.expo, fx.expected.expo, "exponent matches (price · 10^expo)");
	assert.ok(btc!.publishTime > 1_700_000_000, "publish time is a plausible unix timestamp");
});

test("rejects a tampered update (a flipped byte breaks the guardian signatures)", () => {
	// Flip a byte inside the VAA signatures → recovery yields wrong addresses → quorum fails.
	const bytes = Buffer.from(fx.blob, "hex");
	bytes[40] ^= 0xff; // somewhere in the signature region
	assert.deepEqual(verifyPythUpdate(bytes.toString("hex")), [], "no quorum → no price");
});

test("rejects an update signed by a guardian set we don't trust", () => {
	// Verify against a bogus 1-guardian set → the committed setIndex won't match / quorum can't form.
	assert.deepEqual(verifyPythUpdate(fx.blob, ["00".repeat(20)], 999), [], "wrong guardian set → rejected");
});

test("rejects garbage / non-Pyth bytes without throwing", () => {
	assert.deepEqual(verifyPythUpdate("deadbeef"), []);
	assert.deepEqual(verifyPythUpdate(""), []);
	assert.equal(WORMHOLE_GUARDIANS.length, 19, "the trust anchor is the 19-guardian set");
});

test("in the FOLD: a relayed Pyth update sets a pyth market's mark — no reporter, anyone relays", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	// A random account (NOT a designated reporter) relays the attested update.
	const relayer = new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
	await relayer.reportMarketUpdate(fx.blob);
	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	// Fold WITH the channel's pyth feed id → the update verifies and sets the mark.
	const v = computeView(writes, { bornAt: born, market: { kind: "pyth", feedId: fx.expected.feedId } });
	assert.equal(mark(v), BigInt(fx.expected.price), "mark = the guardian-attested Pyth price");

	// Fold WITHOUT a market def (a plain channel) → the update is ignored, no mark.
	assert.equal(mark(computeView(writes, { bornAt: born })), null, "no market configured → update ignored");

	// Fold for a DIFFERENT feed id → the update doesn't match → no mark.
	assert.equal(mark(computeView(writes, { bornAt: born, market: { kind: "pyth", feedId: "ab".repeat(32) } })), null, "wrong feed → ignored");
});
