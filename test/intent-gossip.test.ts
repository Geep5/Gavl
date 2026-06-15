/**
 * Matched-market intents propagate across the mesh (off-ledger gossip): a peer that
 * broadcasts an intent floods it to others' tapes, a new peer is handed the resting
 * book on connect, and it spreads epidemically A→B→C. Verified over the in-memory
 * transport — no sockets, no DHT.
 *
 *   node --test test/intent-gossip.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { keyPairFromSeed } from "../src/det/ed25519.ts";
import { sha256, toHex } from "../src/det/canonical.ts";
import { signOffer, verifyOffer } from "../src/market/intent.ts";
import type { Offer } from "../src/market/intent.ts";
import { PARAMS } from "./helpers.ts";

/** A node plus the daemon-style local offer book + the exact callbacks the daemon wires. */
function node() {
	const n = new GavlNode(new Ledger(PARAMS));
	const offers = new Map<string, Offer>();
	n.onIntent = (o) => {
		if (!o || offers.has(o.nonce) || !verifyOffer(o)) return false;
		offers.set(o.nonce, o);
		return true;
	};
	n.intentsToShare = () => [...offers.values()];
	return { n, offers };
}

function makeOffer(seed: number, nonce: string): Offer {
	const kp = keyPairFromSeed(sha256("maker-" + seed));
	return signOffer({ maker: toHex(kp.publicKey), marketId: "BTC-USD", makerSide: "long", size: "1000", leverage: "5", expiryHeight: 2_000_000_000, nonce }, kp.privateKey);
}

test("a broadcast intent floods to a connected peer's tape", async () => {
	const a = node(), b = node();
	const net = new MemoryNetwork();
	net.link(a.n, b.n);
	await net.idle();

	a.offers.set("m1", makeOffer(1, "m1")); // (the daemon also does this in broadcastIntent)
	a.n.gossipIntent(makeOffer(1, "m1"));
	await net.idle();

	assert.equal(b.offers.size, 1, "B received A's intent");
	assert.equal(b.offers.get("m1")?.maker, makeOffer(1, "m1").maker);
});

test("a new peer is handed the resting book on connect", async () => {
	const a = node(), b = node();
	a.offers.set("m2", makeOffer(2, "m2")); // A already has a resting offer before B shows up
	a.n.intentsToShare = () => [...a.offers.values()];

	const net = new MemoryNetwork();
	net.link(a.n, b.n); // connect → A sends its book
	await net.idle();

	assert.equal(b.offers.size, 1, "B got A's resting offer on connect");
	assert.ok(verifyOffer(b.offers.get("m2")!), "and it's a valid signed offer");
});

test("intents spread epidemically A→B→C", async () => {
	const a = node(), b = node(), c = node();
	const net = new MemoryNetwork();
	net.link(a.n, b.n);
	net.link(b.n, c.n); // C only knows B
	await net.idle();

	a.offers.set("m3", makeOffer(3, "m3"));
	a.n.gossipIntent(makeOffer(3, "m3"));
	await net.idle();

	assert.equal(c.offers.size, 1, "C learned A's intent via B");
});

test("a forged (badly-signed) intent is dropped, not propagated", async () => {
	const a = node(), b = node();
	const net = new MemoryNetwork();
	net.link(a.n, b.n);
	await net.idle();

	const forged = { ...makeOffer(4, "m4"), size: "999999" }; // tampered after signing
	a.n.gossipIntent(forged);
	await net.idle();

	assert.equal(b.offers.size, 0, "B rejected the forged intent");
});
