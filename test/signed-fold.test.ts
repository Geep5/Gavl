/**
 * A generic SIGNED feed through the FOLD — the open analog of the Pyth path. A source signs a
 * reading; ANYONE relays it on-chain (here a random account, NOT a designated reporter); the fold
 * verifies the signature against the channel's committed source key. The Pyth scheme is one of
 * these; this proves the general one: any endpoint that signs can drive a market.
 *
 *   node --test test/signed-fold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, mark } from "../src/market/btc.ts";
import { signReading } from "../src/market/signed-feed.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

test("in the FOLD: a source-signed reading sets a signed market's mark — anyone relays, key is the authority", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;

	// the SOURCE (the endpoint/signer) — its key is the market's trust anchor
	const source = generateKeyPair();
	const sourcePub = toHex(source.publicKey);

	// a random account (NOT the source, NOT a reporter) relays the signed update on-chain
	const relayer = new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
	const update = signReading(6_562_763n, -2, 1_781_510_469, source.privateKey);
	await relayer.reportMarketUpdate(JSON.stringify(update));

	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	// fold WITH the channel's committed source key → the signature verifies → the mark is set
	const v = computeView(writes, { bornAt: born, market: { kind: "signed", source: sourcePub } });
	assert.equal(mark(v), 6_562_763n, "mark = the source-signed price");

	// fold for a DIFFERENT source key → the signature doesn't match → ignored (no mark)
	const wrong = toHex(generateKeyPair().publicKey);
	assert.equal(mark(computeView(writes, { bornAt: born, market: { kind: "signed", source: wrong } })), null, "wrong source key → ignored");

	// fold with NO market def (a plain channel) → ignored
	assert.equal(mark(computeView(writes, { bornAt: born })), null, "no market configured → ignored");
});

test("in the FOLD: a forged update (relayer signs with its OWN key) fails — can't impersonate the source", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;

	const source = generateKeyPair();
	const sourcePub = toHex(source.publicKey);

	// the relayer tries to pass off a reading it signed itself (not the source) for this channel
	const forgerKey = generateKeyPair();
	const forger = new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: forgerKey });
	const forged = signReading(9_999_999n, -2, 1_781_510_500, forgerKey.privateKey);
	await forger.reportMarketUpdate(JSON.stringify(forged));

	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	// the channel commits the SOURCE key → the forged (relayer-signed) update doesn't verify
	const v = computeView(writes, { bornAt: born, market: { kind: "signed", source: sourcePub } });
	assert.equal(mark(v), null, "a relayer can't sign for the source — forged update ignored");
});
