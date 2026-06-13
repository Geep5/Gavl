/**
 * Decentralized median oracle — every node posts its OWN signed reading; the mark is the
 * MEDIAN of recent posters. No single authority key, no special publisher. This proves the
 * fold: median across posters, robustness to an outlier/liar, latest-per-poster, per-poster
 * replay guard, and the recency window aging out a departed poster.
 *
 *   node --test test/oracle-median.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { Account } from "../src/market/account.ts";
import { computeView, ORACLE_WINDOW } from "../src/market/btc.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { PARAMS, K } from "./helpers.ts";

function setup() {
	const node = new GavlNode(new Ledger(PARAMS));
	let t = 0;
	const now = () => ++t;
	const poster = () => new Account({ node, params: PARAMS, k: K, now, keypair: generateKeyPair() });
	return { node, poster };
}
const price = (node: GavlNode): bigint | null => computeView(node.ledger.allWrites()).oracle.price;

test("the mark is the median across posters (no single authority)", async () => {
	const { node, poster } = setup();
	const [a, b, c] = [poster(), poster(), poster()];
	await a.postPrice(60_000n, 0);
	assert.equal(price(node), 60_000n, "one poster → its reading");
	await b.postPrice(62_000n, 0);
	await c.postPrice(61_000n, 0);
	assert.equal(price(node), 61_000n, "three posters → the median (61k), order-independent");
});

test("even count → average of the two middle readings", async () => {
	const { node, poster } = setup();
	await poster().postPrice(60_000n, 0);
	await poster().postPrice(62_000n, 0);
	assert.equal(price(node), 61_000n, "median of {60k,62k} = 61k");
});

test("a lone outlier/liar cannot move the median", async () => {
	const { node, poster } = setup();
	await poster().postPrice(60_000n, 0);
	await poster().postPrice(61_000n, 0);
	await poster().postPrice(62_000n, 0);
	await poster().postPrice(9_999_999n, 0); // a liar posts a wild price
	// sorted {60k,61k,62k,9.99M} → middle two are 61k,62k → 61.5k; the liar is excluded
	assert.equal(price(node), 61_500n, "the outlier sits at the edge, not the middle");
});

test("latest reading per poster wins; a stale seq is rejected", async () => {
	const { node, poster } = setup();
	const a = poster();
	await a.postPrice(60_000n, 0);
	await a.postPrice(65_000n, 1); // a updates its reading
	assert.equal(price(node), 65_000n, "a's latest (seq 1) is used");
	await a.postPrice(50_000n, 0); // replay an old seq
	assert.equal(price(node), 65_000n, "stale seq rejected — still 65k");
});

test("the recency window ages out a poster that stops posting", async () => {
	const { node, poster } = setup();
	const gone = poster();
	const live = poster();
	await gone.postPrice(50_000n, 0); // posts once, then disappears
	await live.postPrice(60_000n, 0);
	assert.equal(price(node), 55_000n, "while both are fresh → median of {50k,60k}");

	// `live` keeps posting until `gone`'s reading falls out of the window
	for (let i = 1; i <= ORACLE_WINDOW; i++) await live.postPrice(60_000n, i);
	assert.equal(price(node), 60_000n, "the departed poster aged out → only the live one counts");
});
