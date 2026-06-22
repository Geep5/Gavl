/**
 * Verifiable encrypted (re)sharing over secp256k1 — the "share blob". See docs/pvss-reshare.md.
 *
 * A reshare today hands sub-shares out point-to-point over a live socket; if a member isn't connected at
 * that instant it straggles. Here a dealer instead produces a DEAL — public Feldman commitments plus one
 * sub-share SEALED to each recipient's X25519 key. Collect the dealers' deals into a blob, anchor it, and:
 *
 *   - anyone verifies a contribution is honest WITHOUT any secret — `C_0 == V_i^{λ_i}` ties it to the
 *     prior epoch's public verifying share, so a dealer can't shift the fund secret (and `Π C_0` is the
 *     fund key, so the reshare provably can't change the Bitcoin address);
 *   - each recipient decrypts only its own sub-share and checks it against the commitments (Feldman);
 *   - a member that was OFFLINE reads the durable blob later and recovers its share — no live ceremony.
 *
 * Two curves, cleanly separated: shares/commitments are secp256k1 (the FROST fund key lives there);
 * the transport sealing each sub-share is X25519 ECDH (committee ids are Ed25519, so members carry a
 * companion X25519 encryption key). The secret is NEVER in the blob in the clear — only ciphertexts and
 * commitments. Signing still needs a threshold online; what this changes is DELIVERY, not the threshold.
 */

import { schnorr_FROST as FROST, secp256k1 } from "@noble/curves/secp256k1.js";
import { mod, randScalar, SECP256K1_N } from "./shamir.ts";
import { fidScalar } from "./committee.ts";
import * as x25519 from "../det/x25519.ts";
import { sha256, concatBytes, fromHex, toHex } from "../det/canonical.ts";

const Fn = FROST.utils.Fn;
const Pt = secp256k1.Point;
const G = Pt.BASE;
type P = ReturnType<typeof Pt.fromHex>;

const ECIES_DOMAIN = new TextEncoder().encode("gavl/pvss/ecies/v1");

/** A sub-share sealed to one recipient's X25519 key (ephemeral ECDH → KDF → one-time pad + tag). */
export interface EncShare {
	eph: string; // ephemeral X25519 public key (hex)
	ct: string; // 32-byte ciphertext (hex): scalar ⊕ KDF(shared)
	tag: string; // sha256(key ‖ ct) (hex) — integrity
}

/** One dealer's verifiable contribution: public commitments + a sealed sub-share per recipient. */
export interface Deal {
	from: string; // the dealer's committee id
	commitments: string[]; // Feldman C_k = G^{a_k}, compressed secp256k1 (hex); C_0 = G^{secret}
	shares: Record<string, EncShare>; // recipient id → its sealed sub-share
	sig?: string; // ceremony-auth signature over the deal by `from` — authenticates the dealer; a forged deal is dropped
}

// ── ECIES: seal/open a 32-byte scalar to an X25519 key ──────────────────────────────────────────────

function seal(recipientX: Uint8Array, scalar32: Uint8Array): EncShare {
	const eph = x25519.generateKeyPair(); // fresh per message → the KDF output is a one-time pad
	const shared = x25519.ecdh(eph.privateKey, recipientX);
	const key = sha256(concatBytes(ECIES_DOMAIN, eph.publicKey, recipientX, shared));
	const ct = new Uint8Array(32);
	for (let i = 0; i < 32; i++) ct[i] = scalar32[i] ^ key[i];
	return { eph: toHex(eph.publicKey), ct: toHex(ct), tag: toHex(sha256(concatBytes(key, ct))) };
}

function open(myKey: x25519.KeyPair, e: EncShare): Uint8Array {
	const eph = fromHex(e.eph);
	const ct = fromHex(e.ct);
	const shared = x25519.ecdh(myKey.privateKey, eph);
	const key = sha256(concatBytes(ECIES_DOMAIN, eph, myKey.publicKey, shared));
	if (toHex(sha256(concatBytes(key, ct))) !== e.tag) throw new Error("pvss: ciphertext failed integrity check");
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i++) out[i] = ct[i] ^ key[i];
	return out;
}

// ── Dealing + verification ──────────────────────────────────────────────────────────────────────────

/** Evaluate p(x) = Σ coeffs[k]·x^k at `xj` (mod n). */
function evalPoly(coeffs: bigint[], xj: bigint): bigint {
	let y = 0n;
	let xpow = 1n;
	for (const a of coeffs) {
		y = mod(y + a * xpow, SECP256K1_N);
		xpow = mod(xpow * xj, SECP256K1_N);
	}
	return y;
}

/** Σ_k C_k^{xj^k} — reconstruct G^{p(xj)} in the exponent from the public commitments. */
function commitmentAt(commitments: string[], xj: bigint): P {
	let acc: P | null = null;
	let xpow = 1n;
	for (const c of commitments) {
		const term = Pt.fromHex(c).multiply(xpow); // xpow starts at 1, then xj, xj²… (never 0 for a valid id)
		acc = acc ? acc.add(term) : term;
		xpow = mod(xpow * xj, SECP256K1_N);
	}
	if (!acc) throw new Error("pvss: empty commitments");
	return acc;
}

/**
 * Deal `secret` to `recipients` at `threshold`, sealing each sub-share to the recipient's X25519 key
 * (`encKeyOf`). The returned Deal is public except the ciphertexts; `C_0 = G^{secret}`.
 */
export function dealVerifiable(from: string, secret: bigint, recipients: string[], threshold: number, encKeyOf: (id: string) => Uint8Array): Deal {
	if (threshold < 1) throw new Error("pvss: threshold must be ≥ 1");
	if (mod(secret, SECP256K1_N) === 0n) throw new Error("pvss: secret/contribution must be nonzero");
	const coeffs: bigint[] = [mod(secret, SECP256K1_N)];
	for (let k = 1; k < threshold; k++) coeffs.push(randScalar());
	const commitments = coeffs.map((a) => toHex(G.multiply(a).toBytes(true)));
	const shares: Record<string, EncShare> = {};
	for (const id of recipients) shares[id] = seal(encKeyOf(id), Fn.toBytes(evalPoly(coeffs, fidScalar(id))));
	return { from, commitments, shares };
}

/**
 * PUBLIC: the dealer's contribution is exactly `λ·s_i` — i.e. `C_0 == oldVerifyingShare^{λ}`. No secret
 * needed. This is what stops a malicious dealer shifting the fund secret during a reshare; combined with
 * `groupKeyOf` it proves the reshare preserves the Bitcoin address. (Higher commitments / the encryption
 * are checked by each recipient via `openShare` — see the doc's security model.)
 */
export function verifyContribution(deal: Deal, oldVerifyingShare: Uint8Array, lambda: bigint): boolean {
	if (deal.commitments.length === 0) return false;
	const l = mod(lambda, SECP256K1_N);
	if (l === 0n) return false;
	try {
		const expected = Pt.fromHex(toHex(oldVerifyingShare)).multiply(l).toBytes(true);
		return deal.commitments[0] === toHex(expected);
	} catch {
		return false; // unparseable point → not valid
	}
}

/** The group key a set of contribution deals reconstructs: `Π_i C_{i,0}`. For a valid reshare this MUST
 *  equal the fixed fund key (proof the address is unchanged). */
export function groupKeyOf(deals: Deal[]): Uint8Array {
	let acc: P | null = null;
	for (const d of deals) {
		const c0 = Pt.fromHex(d.commitments[0]);
		acc = acc ? acc.add(c0) : c0;
	}
	if (!acc) throw new Error("pvss: no deals");
	return acc.toBytes(true);
}

/** The new verifying share for member `id` implied by the deals: `Σ_i Π_k C_{i,k}^{x_id^k} = G^{s'_id}`.
 *  Publicly computable — lets every node assemble the new package without holding a share. */
export function newVerifyingShare(deals: Deal[], id: string): Uint8Array {
	const xj = fidScalar(id);
	let acc: P | null = null;
	for (const d of deals) {
		const term = commitmentAt(d.commitments, xj);
		acc = acc ? acc.add(term) : term;
	}
	if (!acc) throw new Error("pvss: no deals");
	return acc.toBytes(true);
}

/**
 * RECIPIENT: decrypt my sub-share from one deal and verify it against the deal's Feldman commitments
 * (`G^y == Σ_k C_k^{x^k}`). Returns the scalar, or THROWS if the ciphertext is corrupt or the share
 * doesn't match the commitments — i.e. the dealer cheated, and the caller should file a complaint.
 *
 * The recipient's new share is the SUM of `openShare` over every dealer's deal.
 */
export function openShare(deal: Deal, myId: string, myKey: x25519.KeyPair): bigint {
	const e = deal.shares[myId];
	if (!e) throw new Error(`pvss: deal from ${deal.from} carries no share for ${myId}`);
	const y = Fn.fromBytes(open(myKey, e)); // a real share scalar (nonzero w.p. 1 over a 256-bit field)
	const lhs = toHex(G.multiply(y).toBytes(true));
	const rhs = toHex(commitmentAt(deal.commitments, fidScalar(myId)).toBytes(true));
	if (lhs !== rhs) throw new Error(`pvss: share from ${deal.from} fails the Feldman check (dealer cheated → complain)`);
	return y;
}
