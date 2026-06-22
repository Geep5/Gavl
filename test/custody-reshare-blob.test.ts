/**
 * Reshare blob assembly + verification (docs/pvss-reshare.md, phase 2).
 *
 *   node --test test/custody-reshare-blob.test.ts
 *
 * End to end over the blob API (buildContribution / verifyBlob / combineShare) with enckey-derived keys:
 * an old quorum's contributions reshare the SAME secret to a new committee, the blob verifies publicly,
 * and a new member recovers its share from the blob alone (offline-safe).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as ed from "../src/det/ed25519.ts";
import { deriveEncKey, announceEncKey, EncKeyRegistry } from "../src/custody/enckey.ts";
import { buildContribution, verifyBlob, combineShare, newVerifyingShares, type ReshareBlob } from "../src/custody/reshare-blob.ts";
import { mod, randScalar, SECP256K1_N as N, lagrangeAtZero } from "../src/custody/shamir.ts";
import { fidScalar } from "../src/custody/committee.ts";
import { toHex } from "../src/det/canonical.ts";

const G = secp256k1.Point.BASE;
const gx = (k: bigint): string => toHex(G.multiply(k).toBytes(true));
const ev = (coeffs: bigint[], xj: bigint): bigint => {
	let y = 0n;
	let xp = 1n;
	for (const a of coeffs) {
		y = mod(y + a * xp, N);
		xp = mod(xp * xj, N);
	}
	return y;
};
const reconstruct = (shares: { x: bigint; y: bigint }[]): bigint => {
	const xs = shares.map((s) => s.x);
	return shares.reduce((acc, sh) => mod(acc + sh.y * lagrangeAtZero(sh.x, xs, N), N), 0n);
};

/** A fresh valid reshare: old 2-of-3 sharing of `secret`, quorum {A,B} → new {D,E,F}. */
function fixture() {
	const secret = randScalar();
	const oldPoly = [secret, randScalar()];
	const old = [0, 1, 2].map(() => ed.generateKeyPair());
	const oldIds = old.map((k) => toHex(k.publicKey));
	const oldShare = Object.fromEntries(oldIds.map((id) => [id, ev(oldPoly, fidScalar(id))]));
	const oldVS = Object.fromEntries(oldIds.map((id) => [id, G.multiply(oldShare[id]).toBytes(true)]));

	const next = [0, 1, 2].map(() => ed.generateKeyPair());
	const nextIds = next.map((k) => toHex(k.publicKey));
	const reg = new EncKeyRegistry();
	next.forEach((k, i) => reg.learn(announceEncKey(k.privateKey, nextIds[i])));

	const quorum = [oldIds[0], oldIds[1]];
	const deals = quorum.map((id) => buildContribution(id, oldShare[id], quorum, nextIds, 2, (x) => reg.get(x)!));
	const blob: ReshareBlob = { epoch: 5, oldQuorum: quorum, newCommittee: nextIds, newMin: 2, groupKey: gx(secret), deals };
	return { secret, blob, oldVS, next, nextIds };
}

test("a reshare blob hands the same secret to a new committee — verifiable + offline-recoverable", () => {
	const { secret, blob, oldVS, next, nextIds } = fixture();

	assert.equal(verifyBlob(blob, (id) => oldVS[id]), true, "blob verifies publicly (honest contributions + fund key preserved)");

	// each new member recovers its share from the blob + its own derived key alone (no live state)
	const newShare = Object.fromEntries(next.map((k, i) => [nextIds[i], combineShare(blob, nextIds[i], deriveEncKey(k.privateKey))]));
	const vs = newVerifyingShares(blob);
	nextIds.forEach((id) => assert.equal(gx(newShare[id]), vs[id], "new share matches its public verifying share"));

	const rec = reconstruct([{ x: fidScalar(nextIds[0]), y: newShare[nextIds[0]] }, { x: fidScalar(nextIds[1]), y: newShare[nextIds[1]] }]);
	assert.equal(rec, secret, "new committee reconstructs the ORIGINAL secret → signs for the same address");
});

test("verifyBlob rejects a shifted contribution, a wrong group key, and a malformed quorum", () => {
	const base = fixture();

	const shifted = structuredClone(base.blob);
	shifted.deals[0].commitments[0] = gx(randScalar()); // a C_0 that isn't V_i^λ
	assert.equal(verifyBlob(shifted, (id) => base.oldVS[id]), false, "shifted contribution rejected");

	const wrongKey = structuredClone(base.blob);
	wrongKey.groupKey = gx(randScalar());
	assert.equal(verifyBlob(wrongKey, (id) => base.oldVS[id]), false, "a blob claiming the wrong fund key is rejected");

	const malformed = structuredClone(base.blob);
	malformed.deals = [malformed.deals[0]]; // dropped a quorum member's deal
	assert.equal(verifyBlob(malformed, (id) => base.oldVS[id]), false, "deal set must match the quorum");
});

test("combineShare throws when a deal sealed a recipient a bad share (→ complaint)", () => {
	const { blob, nextIds, next } = fixture();
	const tampered = structuredClone(blob);
	tampered.deals[0].commitments[1] = gx(randScalar()); // breaks the Feldman check for every recipient of deal 0
	assert.throws(() => combineShare(tampered, nextIds[0], deriveEncKey(next[0].privateKey)), /Feldman/, "recipient catches the cheat");
});
