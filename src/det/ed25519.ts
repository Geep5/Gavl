/**
 * Ed25519 signing/verification with raw 32-byte keys.
 *
 * Node's `crypto` supports Ed25519 but wants SPKI/PKCS8 DER, not the raw
 * 32-byte form that encodes naturally on the wire. This module bridges the
 * two: every public function takes/returns raw bytes; the DER wrapping is
 * internal. Built-in crypto — no third-party signature dependency in the
 * trust path. (Ported from glon's src/det/ed25519.ts.)
 */

import {
	createPublicKey,
	createPrivateKey,
	generateKeyPairSync,
	sign as cryptoSign,
	verify as cryptoVerify,
} from "node:crypto";

/** SPKI prefix for a 32-byte Ed25519 public key. RFC 8410, fixed. */
const SPKI_PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** PKCS8 prefix for a 32-byte Ed25519 private key seed. RFC 8410, fixed. */
const PKCS8_PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface KeyPair {
	/** 32-byte raw Ed25519 public key. */
	publicKey: Uint8Array;
	/** 32-byte raw Ed25519 private key seed. */
	privateKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
	const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
	// Raw key is the trailing 32 bytes of each DER structure.
	return {
		publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
		privateKey: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
	};
}

/** Deterministically derive a keypair from a 32-byte seed (the Ed25519 private seed). */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
	if (seed.length !== 32) throw new Error(`ed25519: seed must be 32 bytes, got ${seed.length}`);
	const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PRIVATE_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
	const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
	return { publicKey: new Uint8Array(spki.subarray(spki.length - 32)), privateKey: new Uint8Array(seed) };
}

function publicKeyObject(raw: Uint8Array) {
	if (raw.length !== 32) throw new Error(`ed25519: public key must be 32 bytes, got ${raw.length}`);
	return createPublicKey({
		key: Buffer.concat([SPKI_PUBLIC_PREFIX, Buffer.from(raw)]),
		format: "der",
		type: "spki",
	});
}

function privateKeyObject(raw: Uint8Array) {
	if (raw.length !== 32) throw new Error(`ed25519: private key seed must be 32 bytes, got ${raw.length}`);
	return createPrivateKey({
		key: Buffer.concat([PKCS8_PRIVATE_PREFIX, Buffer.from(raw)]),
		format: "der",
		type: "pkcs8",
	});
}

/** Sign a message with a raw 32-byte private key seed. Returns a 64-byte signature. */
export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
	return new Uint8Array(cryptoSign(null, Buffer.from(message), privateKeyObject(privateKey)));
}

/** Verify a signature against a raw 32-byte public key. Never throws. */
export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
	try {
		return cryptoVerify(null, Buffer.from(message), publicKeyObject(publicKey), Buffer.from(signature));
	} catch {
		return false;
	}
}
