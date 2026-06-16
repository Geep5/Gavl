/**
 * A generic SIGNED feed through the FOLD — the open analog of the Pyth path, M-of-N. A signer SET
 * signs a reading; ANYONE relays it on-chain (here a random account, NOT a designated reporter); the
 * fold verifies the QUORUM against the channel's committed set hash. The Pyth scheme is one of these
 * (a big guardian set); this proves the general one: any M-of-N Ed25519 set can drive a market.
 *
 *   node --test test/signed-fold.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, mark } from "../src/market/btc.ts";
import { signReading, buildSignedUpdate, signerSetHash, type SignerSet } from "../src/market/signed-feed.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K } from "./helpers.ts";

/** A 2-of-3 signer set + a helper to produce a quorum update from chosen members. */
function makeSet() {
	const members = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
	const set: SignerSet = { threshold: 2, signers: members.map((m) => toHex(m.publicKey)) };
	const sign = (price: bigint, expo: number, t: number, who: number[]) => {
		const sigBy: Record<string, string> = {};
		for (const i of who) sigBy[toHex(members[i].publicKey)] = signReading(price, expo, t, members[i].privateKey);
		return buildSignedUpdate(price, expo, t, set, sigBy);
	};
	return { members, set, hash: signerSetHash(set), sign };
}

test("in the FOLD: a quorum-signed reading sets a signed market's mark — anyone relays, the set is the authority", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;

	// the signer SET (the endpoints/signers) — its committed hash is the market's trust anchor
	const { hash, sign } = makeSet();

	// a random account (NOT a member, NOT a reporter) relays the quorum update on-chain
	const relayer = new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
	const update = sign(6_562_763n, -2, 1_781_510_469, [0, 1]); // 2-of-3
	await relayer.reportMarketUpdate(JSON.stringify(update));

	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	// fold WITH the channel's committed set hash → the quorum verifies → the mark is set
	const v = computeView(writes, { bornAt: born, market: { kind: "signed", signerSet: hash } });
	assert.equal(mark(v), 6_562_763n, "mark = the quorum-signed price");

	// fold for a DIFFERENT set hash → the quorum doesn't match → ignored (no mark)
	const wrong = signerSetHash(makeSet().set);
	assert.equal(mark(computeView(writes, { bornAt: born, market: { kind: "signed", signerSet: wrong } })), null, "wrong set hash → ignored");

	// fold with NO market def (a plain channel) → ignored
	assert.equal(mark(computeView(writes, { bornAt: born })), null, "no market configured → ignored");
});

test("in the FOLD: a sub-quorum update fails — one member can't move the price", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const { hash, sign } = makeSet();

	const relayer = new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
	const update = sign(9_999_999n, -2, 1_781_510_500, [0]); // only 1 of the required 2
	await relayer.reportMarketUpdate(JSON.stringify(update));

	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	const v = computeView(writes, { bornAt: born, market: { kind: "signed", signerSet: hash } });
	assert.equal(mark(v), null, "a single member is below the 2-of-3 quorum — ignored");
});

test("in the FOLD: a forged set (relayer's own keys) fails — can't impersonate the committed set", async () => {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;

	const { hash } = makeSet(); // the channel commits THIS set's hash
	const forgeSet = makeSet(); // the relayer fabricates its OWN 2-of-3 set and fully signs it

	const forger = new Account({ node, params: PARAMS, k: K, now: () => ++t, keypair: generateKeyPair() });
	const forged = forgeSet.sign(9_999_999n, -2, 1_781_510_500, [0, 1, 2]);
	await forger.reportMarketUpdate(JSON.stringify(forged));

	const writes = node.ledger.allWrites();
	const born = new Map(writes.map((w) => [w.id, 0] as [string, number]));

	// the channel commits the real set's hash → the forged set hashes differently → ignored
	const v = computeView(writes, { bornAt: born, market: { kind: "signed", signerSet: hash } });
	assert.equal(mark(v), null, "a relayer's own set doesn't match the committed hash — forged update ignored");
});
