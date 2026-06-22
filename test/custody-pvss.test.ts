/**
 * Verifiable encrypted resharing primitive (the "share blob") — see docs/pvss-reshare.md.
 *
 *   node --test test/custody-pvss.test.ts
 *
 * Proves the construction end to end: a dealer seals sub-shares to recipients' X25519 keys + publishes
 * Feldman commitments; recipients decrypt + verify; an old committee's Lagrange-weighted contributions
 * reshare the SAME secret to a new committee (so the fund key/address is preserved) — all without the
 * secret ever being assembled in transit, and with public verifiability of every contribution.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { dealVerifiable, verifyContribution, groupKeyOf, newVerifyingShare, openShare } from "../src/custody/pvss.ts";
import { generateKeyPair, type KeyPair } from "../src/det/x25519.ts";
import { mod, randScalar, SECP256K1_N as N, lagrangeAtZero } from "../src/custody/shamir.ts";
import { fidScalar } from "../src/custody/committee.ts";
import { toHex } from "../src/det/canonical.ts";

const G = secp256k1.Point.BASE;
const gx = (k: bigint): string => toHex(G.multiply(k).toBytes(true)); // G^k compressed hex

/** Evaluate Σ coeffs[k]·x^k (mod n) — the dealer's polynomial, for building test fixtures. */
function ev(coeffs: bigint[], xj: bigint): bigint {
	let y = 0n;
	let xp = 1n;
	for (const a of coeffs) {
		y = mod(y + a * xp, N);
		xp = mod(xp * xj, N);
	}
	return y;
}

/** Reconstruct the secret at 0 from `{x,y}` shares via Lagrange. */
function reconstruct(shares: { x: bigint; y: bigint }[]): bigint {
	const xs = shares.map((s) => s.x);
	let s = 0n;
	for (const sh of shares) s = mod(s + sh.y * lagrangeAtZero(sh.x, xs, N), N);
	return s;
}

/** A set of members each with an X25519 encryption key, and an `encKeyOf` resolver. */
function members(ids: string[]) {
	const keys: Record<string, KeyPair> = {};
	for (const id of ids) keys[id] = generateKeyPair();
	return { keys, encKeyOf: (id: string) => keys[id].publicKey };
}

test("deal → open round-trips, the Feldman check holds, and any threshold reconstructs the secret", () => {
	const recipients = ["A", "B", "C"];
	const { keys, encKeyOf } = members(recipients);
	const secret = randScalar();

	const deal = dealVerifiable("dealer", secret, recipients, 2, encKeyOf);

	// each recipient decrypts + passes the Feldman check (openShare throws otherwise)
	const opened: Record<string, bigint> = {};
	for (const id of recipients) opened[id] = openShare(deal, id, keys[id]);

	// C_0 is exactly G^secret, and each opened share matches its public verifying share
	assert.equal(deal.commitments[0], gx(secret), "C_0 == G^secret");
	for (const id of recipients) assert.equal(gx(opened[id]), toHex(newVerifyingShare([deal], id)), "G^share == published verifying share");

	// any 2-of-3 reconstructs the secret; the secret was never assembled in transit
	const sAB = reconstruct([{ x: fidScalar("A"), y: opened["A"] }, { x: fidScalar("B"), y: opened["B"] }]);
	const sBC = reconstruct([{ x: fidScalar("B"), y: opened["B"] }, { x: fidScalar("C"), y: opened["C"] }]);
	assert.equal(sAB, secret, "2-of-3 {A,B} reconstructs the secret");
	assert.equal(sBC, secret, "2-of-3 {B,C} reconstructs the secret");
});

test("verifyContribution is public: an honest λ·s contribution passes, a shifted one fails", () => {
	const newCommittee = ["D", "E", "F"];
	const { encKeyOf } = members(newCommittee);
	const sI = randScalar(); // an old member's share
	const Vi = G.multiply(sI).toBytes(true); // its PUBLIC verifying share
	const lambda = randScalar();

	const honest = dealVerifiable("old", mod(lambda * sI, N), newCommittee, 2, encKeyOf);
	assert.equal(verifyContribution(honest, Vi, lambda), true, "C_0 == V_i^λ — honest contribution verifies from public data");

	const shifted = dealVerifiable("old", mod(lambda * sI + 7n, N), newCommittee, 2, encKeyOf);
	assert.equal(verifyContribution(shifted, Vi, lambda), false, "a contribution that isn't λ·s_i is rejected — no secret-shifting");
});

test("a full reshare hands the SAME secret to a new committee — fund key/address preserved", () => {
	// OLD committee holds a 2-of-3 sharing of `secret`
	const secret = randScalar();
	const oldPoly = [secret, randScalar()]; // degree 1 (oldMin = 2)
	const old = ["A", "B", "C"];
	const shareOf = Object.fromEntries(old.map((id) => [id, ev(oldPoly, fidScalar(id))]));
	const vshareOf = Object.fromEntries(old.map((id) => [id, G.multiply(shareOf[id]).toBytes(true)]));

	// OLD quorum {A,B} hands off; each contributes λ_i·s_i (Σ = secret by Lagrange)
	const quorum = ["A", "B"];
	const qxs = quorum.map(fidScalar);
	const lambdaOf = Object.fromEntries(quorum.map((id) => [id, lagrangeAtZero(fidScalar(id), qxs, N)]));

	// NEW committee {D,E,F}, threshold 2
	const next = ["D", "E", "F"];
	const { keys, encKeyOf } = members(next);
	const deals = quorum.map((id) => dealVerifiable(id, mod(lambdaOf[id] * shareOf[id], N), next, 2, encKeyOf));

	// PUBLIC checks: every contribution is honest, and the blob reconstructs the ORIGINAL fund key
	for (const id of quorum) assert.equal(verifyContribution(deals[quorum.indexOf(id)], vshareOf[id], lambdaOf[id]), true, `${id}'s contribution verifies`);
	assert.equal(toHex(groupKeyOf(deals)), gx(secret), "Π C_0 == G^secret — the reshare cannot change the address");

	// NEW members open + sum their sub-shares → their new shares (offline-recoverable from the durable deals)
	const newShareOf = Object.fromEntries(next.map((id) => [id, deals.reduce((acc, d) => mod(acc + openShare(d, id, keys[id]), N), 0n)]));
	for (const id of next) assert.equal(gx(newShareOf[id]), toHex(newVerifyingShare(deals, id)), `${id}'s new share matches its public verifying share`);

	// the new committee's shares reconstruct the SAME secret — so they FROST-sign for the same key
	const sDE = reconstruct([{ x: fidScalar("D"), y: newShareOf["D"] }, { x: fidScalar("E"), y: newShareOf["E"] }]);
	const sDF = reconstruct([{ x: fidScalar("D"), y: newShareOf["D"] }, { x: fidScalar("F"), y: newShareOf["F"] }]);
	assert.equal(sDE, secret, "new {D,E} reconstructs the ORIGINAL secret");
	assert.equal(sDF, secret, "new {D,F} reconstructs the ORIGINAL secret");
});

test("a recipient detects a tampered ciphertext (integrity tag) and a tampered commitment (Feldman)", () => {
	const recipients = ["A", "B", "C"];
	const { keys, encKeyOf } = members(recipients);
	const deal = dealVerifiable("dealer", randScalar(), recipients, 2, encKeyOf);

	// (a) flip a byte of A's ciphertext → the integrity tag rejects it
	const ctTampered = structuredClone(deal);
	const ct = ctTampered.shares["A"].ct;
	ctTampered.shares["A"].ct = (ct[0] === "0" ? "1" : "0") + ct.slice(1);
	assert.throws(() => openShare(ctTampered, "A", keys["A"]), /integrity/, "a flipped ciphertext is caught by the tag");

	// (b) replace a commitment with a different point → A's (correct) share fails the Feldman check
	const cmtTampered = structuredClone(deal);
	cmtTampered.commitments[1] = gx(randScalar());
	assert.throws(() => openShare(cmtTampered, "A", keys["A"]), /Feldman/, "a tampered commitment is caught by the Feldman check");
});
