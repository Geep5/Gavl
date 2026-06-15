/**
 * Generic signed price feed — the Pyth model generalized to any source. A source signs
 * its reading; the channel commits the source key; anyone relays; the fold verifies the
 * signature against the committed key (a forged/tampered/wrong-key update fails).
 *
 *   node --test test/signed-feed.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { signReading, verifySignedReading } from "../src/market/signed-feed.ts";
import { generateKeyPair } from "../src/det/ed25519.ts";
import { toHex } from "../src/det/canonical.ts";

test("a source-signed reading verifies against the committed source key", () => {
	const src = generateKeyPair();
	const srcPub = toHex(src.publicKey);
	const u = signReading(6_591_845_500_000n, -8, 1_718_400_000, src.privateKey);

	const r = verifySignedReading(u, srcPub);
	assert.ok(r, "genuine update verifies");
	assert.equal(r!.price, 6_591_845_500_000n);
	assert.equal(r!.expo, -8);
	assert.equal(r!.publishTime, 1_718_400_000);
});

test("tampering, a wrong source key, or a malformed blob all fail (relayer can't forge)", () => {
	const src = generateKeyPair();
	const srcPub = toHex(src.publicKey);
	const u = signReading(65_000n, -2, 1_718_400_000, src.privateKey);

	assert.equal(verifySignedReading({ ...u, price: "99999999" }, srcPub), null, "tampered price fails");
	assert.equal(verifySignedReading({ ...u, publishTime: u.publishTime + 1 }, srcPub), null, "tampered time fails");
	assert.equal(verifySignedReading(u, toHex(generateKeyPair().publicKey)), null, "a different source key fails");
	assert.equal(verifySignedReading({ price: "65000", expo: -2, publishTime: 1, sig: "zz" }, srcPub), null, "garbage sig fails");
	assert.equal(verifySignedReading(null, srcPub), null, "null is rejected, not thrown");

	// the relayer is irrelevant — the SOURCE signature is what's checked, so anyone can post it
	assert.ok(verifySignedReading(u, srcPub), "the genuine one still verifies for any relayer");
});
