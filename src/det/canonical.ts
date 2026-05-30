/**
 * Deterministic encoding + hashing.
 *
 * Consensus depends on every node computing byte-identical bytes and hashes
 * for the same logical value. This module is the single source of "canonical
 * bytes": object keys are sorted recursively, no incidental whitespace, UTF-8.
 *
 * Keep this module free of nondeterministic APIs (Date.now, Math.random,
 * floats in hashed paths). Payloads that reach `canonicalBytes` must be
 * JSON-shaped (string | number | boolean | null | array | plain object).
 */

import { createHash } from "node:crypto";

// ── Hashing ──────────────────────────────────────────────────────

export function sha256(data: Uint8Array | string): Uint8Array {
	const h = createHash("sha256");
	h.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
	return new Uint8Array(h.digest());
}

export function sha256Hex(data: Uint8Array | string): string {
	return Buffer.from(sha256(data)).toString("hex");
}

// ── Hex ──────────────────────────────────────────────────────────

export function toHex(b: Uint8Array): string {
	return Buffer.from(b).toString("hex");
}

export function fromHex(h: string): Uint8Array {
	return new Uint8Array(Buffer.from(h, "hex"));
}

// ── Byte helpers ─────────────────────────────────────────────────

export function concatBytes(...arrs: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const a of arrs) len += a.length;
	const out = new Uint8Array(len);
	let off = 0;
	for (const a of arrs) {
		out.set(a, off);
		off += a.length;
	}
	return out;
}

/** Big-endian unsigned 32-bit encoding. */
export function u32be(n: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n >>> 0, false);
	return b;
}

/** Lexicographic byte comparison: <0, 0, >0. */
export function cmpBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return a.length - b.length;
}

// ── Canonical JSON ───────────────────────────────────────────────

function sortValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortValue);
	if (v && typeof v === "object") {
		const src = v as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(src).sort()) out[k] = sortValue(src[k]);
		return out;
	}
	return v;
}

/** Deterministic JSON string: recursively key-sorted, no extra whitespace. */
export function canonicalize(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

/** UTF-8 bytes of the canonical JSON encoding. */
export function canonicalBytes(value: unknown): Uint8Array {
	return new Uint8Array(Buffer.from(canonicalize(value), "utf8"));
}
