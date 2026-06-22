/**
 * X25519 (Curve25519) ECDH with raw 32-byte keys — the encryption transport for verifiable
 * encrypted resharing (see docs/pvss-reshare.md). Committee ids are Ed25519 *signing* keys; for
 * resharing each member additionally holds a long-term X25519 *encryption* key, so a sub-share can
 * be sealed to it (ECDH → KDF → one-time pad).
 *
 * Mirrors det/ed25519.ts: node's `crypto` speaks SPKI/PKCS8 DER, not the raw 32-byte form that
 * encodes naturally on the wire, so this module bridges the two — every public function takes/returns
 * raw bytes; the DER wrapping is internal. Built-in crypto — no third-party in the trust path.
 */

import { createPublicKey, createPrivateKey, generateKeyPairSync, diffieHellman } from "node:crypto";

/** SPKI prefix for a 32-byte X25519 public key. RFC 8410 (OID 1.3.101.110 = 2b656e), fixed. */
const SPKI_PUBLIC_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
/** PKCS8 prefix for a 32-byte X25519 private key. RFC 8410, fixed. */
const PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

export interface KeyPair {
	/** 32-byte raw X25519 public key. */
	publicKey: Uint8Array;
	/** 32-byte raw X25519 private key. */
	privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
	const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
	// Raw key is the trailing 32 bytes of each DER structure.
	return {
		publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
		privateKey: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
	};
}

/** Deterministically derive a keypair from a 32-byte seed (X25519 clamps it internally at use). */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
	if (seed.length !== 32) throw new Error(`x25519: seed must be 32 bytes, got ${seed.length}`);
	const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PRIVATE_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
	const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
	return { publicKey: new Uint8Array(spki.subarray(spki.length - 32)), privateKey: new Uint8Array(seed) };
}

function publicKeyObject(raw: Uint8Array) {
	if (raw.length !== 32) throw new Error(`x25519: public key must be 32 bytes, got ${raw.length}`);
	return createPublicKey({ key: Buffer.concat([SPKI_PUBLIC_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
}

function privateKeyObject(raw: Uint8Array) {
	if (raw.length !== 32) throw new Error(`x25519: private key must be 32 bytes, got ${raw.length}`);
	return createPrivateKey({ key: Buffer.concat([PKCS8_PRIVATE_PREFIX, Buffer.from(raw)]), format: "der", type: "pkcs8" });
}

/** Raw X25519 ECDH — the 32-byte shared secret from my private key + their public key.
 *  Symmetric: ecdh(a.priv, b.pub) === ecdh(b.priv, a.pub). */
export function ecdh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
	return new Uint8Array(diffieHellman({ privateKey: privateKeyObject(privateKey), publicKey: publicKeyObject(publicKey) }));
}
