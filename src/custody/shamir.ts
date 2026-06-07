/**
 * Shamir Secret Sharing over the secp256k1 scalar field — Phase-0 spike.
 *
 * Splits a secret scalar into `total` shares such that any `threshold` of them
 * reconstruct it and any `threshold-1` learn NOTHING. The field is secp256k1's
 * group order `n`, so a shared value can later be a real Bitcoin private-key
 * scalar — these shares compose with threshold signing without re-encoding.
 *
 * This is the foundation of the scaling-threshold custody design
 * (docs/scaling-threshold-custody.md): the fund key exists only as shares; a
 * quorum reconstructs/co-signs without the full key ever being assembled.
 *
 * NOT WIRED into consensus. Standalone, dependency-free, property-tested.
 * `split` uses real CSPRNG randomness (security-critical for dealing); the field
 * prime is the only hardcoded constant. Reconstruction is deterministic.
 */

import { randomBytes } from "node:crypto";

/** secp256k1 group order (the scalar field). Public constant. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface Share {
	/** Evaluation point (committee member id ≥ 1; x=0 is the secret, never a share). */
	x: bigint;
	/** poly(x) mod n. */
	y: bigint;
}

export function mod(a: bigint, n: bigint): bigint {
	const r = a % n;
	return r < 0n ? r + n : r;
}

function modpow(base: bigint, exp: bigint, n: bigint): bigint {
	let b = mod(base, n);
	let r = 1n;
	let e = exp;
	while (e > 0n) {
		if (e & 1n) r = mod(r * b, n);
		b = mod(b * b, n);
		e >>= 1n;
	}
	return r;
}

/** Modular inverse via Fermat (n is prime). */
export function modinv(a: bigint, n: bigint): bigint {
	return modpow(a, n - 2n, n);
}

/** A uniform nonzero scalar in [1, n-1] via rejection on 32 random bytes. */
export function randScalar(n: bigint = SECP256K1_N): bigint {
	for (;;) {
		const v = mod(BigInt("0x" + randomBytes(32).toString("hex")), n);
		if (v !== 0n) return v;
	}
}

/**
 * Split `secret` into `total` shares with reconstruction `threshold`.
 * poly(0) = secret; the other `threshold-1` coefficients are random.
 * `rng` is injectable for deterministic tests; defaults to CSPRNG.
 */
export function split(secret: bigint, total: number, threshold: number, n: bigint = SECP256K1_N, rng: (n: bigint) => bigint = randScalar): Share[] {
	if (threshold < 1 || threshold > total) throw new Error("shamir: need 1 <= threshold <= total");
	const coeffs: bigint[] = [mod(secret, n)];
	for (let i = 1; i < threshold; i++) coeffs.push(rng(n));
	const shares: Share[] = [];
	for (let id = 1; id <= total; id++) {
		const x = BigInt(id);
		let y = 0n;
		let xp = 1n; // x^0, x^1, ...
		for (const c of coeffs) {
			y = mod(y + c * xp, n);
			xp = mod(xp * x, n);
		}
		shares.push({ x, y });
	}
	return shares;
}

/** Lagrange basis coefficient for share i, evaluated at x=0, over `xs`. */
export function lagrangeAtZero(xi: bigint, xs: bigint[], n: bigint = SECP256K1_N): bigint {
	let num = 1n;
	let den = 1n;
	for (const xj of xs) {
		if (xj === xi) continue;
		num = mod(num * mod(-xj, n), n);
		den = mod(den * mod(xi - xj, n), n);
	}
	return mod(num * modinv(den, n), n);
}

/**
 * Reconstruct the secret from ≥`threshold` shares (Lagrange interpolation at 0).
 * Fewer than `threshold` shares interpolate a different polynomial → wrong value
 * (this IS the security property; see the test). Deterministic.
 */
export function reconstruct(shares: Share[], n: bigint = SECP256K1_N): bigint {
	const xs = shares.map((s) => s.x);
	let secret = 0n;
	for (const s of shares) {
		const lambda = lagrangeAtZero(s.x, xs, n);
		secret = mod(secret + s.y * lambda, n);
	}
	return secret;
}
