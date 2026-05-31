/**
 * Sealed-secret crypto: confidential, verifiable delivery (no trusted party).
 *
 *   node --test test/seal.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSealKeyPair, freshSalt, commit, verifyCommitment, seal, openSealed, vaultKey, vaultEncrypt, vaultDecrypt } from "../src/secret/seal.ts";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

test("sealed box: only the recipient can open the secret", () => {
	const winner = generateSealKeyPair();
	const stranger = generateSealKeyPair();
	const secret = enc("the treasure is buried under the oak");

	const cipher = seal(secret, winner.publicKey);
	assert.equal(dec(openSealed(cipher, winner)), "the treasure is buried under the oak", "winner opens it");
	assert.equal(openSealed(cipher, stranger), null, "a stranger cannot open it");
});

test("commitment binds the listing to the exact secret (no swap at settle)", () => {
	const secret = enc("rosebud");
	const salt = freshSalt();
	const c = commit(secret, salt);

	assert.equal(verifyCommitment(secret, salt, c), true, "the real secret verifies");
	assert.equal(verifyCommitment(enc("not rosebud"), salt, c), false, "a swapped secret fails the commitment");
	assert.equal(verifyCommitment(secret, freshSalt(), c), false, "wrong salt fails too");
});

test("end-to-end: list (commit) → deliver (seal) → winner verifies against commitment", () => {
	// Seller side: make the secret + commitment that goes in the listing.
	const secret = enc("BEGIN MESSAGE… meet at dawn");
	const salt = freshSalt();
	const listedCommitment = commit(secret, salt);

	// Winner publishes a delivery pubkey in their bid.
	const winner = generateSealKeyPair();

	// Settle: seller seals (secret‖salt) to the winner.
	const payload = new Uint8Array([...salt, ...secret]);
	const cipher = seal(payload, winner.publicKey);

	// Winner: open, split, and verify it matches the commitment they saw when bidding.
	const opened = openSealed(cipher, winner);
	assert.ok(opened, "winner opened the delivery");
	const gotSalt = opened.slice(0, 16);
	const gotSecret = opened.slice(16);
	assert.equal(verifyCommitment(gotSecret, gotSalt, listedCommitment), true, "delivered secret matches the listed commitment");
	assert.equal(dec(gotSecret), "BEGIN MESSAGE… meet at dawn");
});

test("at-rest vault: the seller's secret survives encrypted, opens only with the right key", () => {
	const key = vaultKey(enc("seed-material"));
	const wrong = vaultKey(enc("other-seed"));
	const secret = enc("private note that must persist locally");

	const blob = vaultEncrypt(secret, key);
	assert.notEqual(blob, dec(secret), "stored form is ciphertext, not plaintext");
	assert.equal(dec(vaultDecrypt(blob, key)), "private note that must persist locally", "right key decrypts");
	assert.equal(vaultDecrypt(blob, wrong), null, "wrong key fails (MAC)");
});
