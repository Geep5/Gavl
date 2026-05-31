/**
 * Sealed-secret crypto — confidential, verifiable DELIVERY of a secret to an
 * auction winner. No trusted third party; pure libsodium between seller and
 * winner.
 *
 * Two primitives:
 *  - COMMITMENT: a listing publishes only `sha256(salt ‖ secret)`, never the
 *    secret. On delivery the winner re-derives the hash and checks it matches —
 *    so the seller cannot swap in a different secret at settle time.
 *  - SEALED BOX (crypto_box_seal: X25519 + XSalsa20-Poly1305): at settle the
 *    secret is encrypted to the WINNER's public key. Only the winner's secret
 *    key opens it; the sealed bytes carry no sender key, so they're safe to
 *    publish in the settle write.
 *
 * WHAT THIS IS: confidential, tamper-evident delivery — good for messages,
 * notes, codes, credentials, art: things whose value survives the seller also
 * holding a copy.
 *
 * WHAT THIS IS NOT: fair exchange. The seller inherently retains a copy of the
 * secret (you can't un-know it). For anything that controls funds (a private
 * key), the seller can use their copy after being paid. The protocol cannot
 * prevent this; the UI must warn loudly. This module makes delivery private and
 * verifiable — it does not make the seller forget.
 */

import sodium from "sodium-native";
import { sha256, toHex, fromHex, concatBytes } from "../det/canonical.ts";

export interface SealKeyPair {
	publicKey: Uint8Array; // 32-byte X25519 public key (a bidder's "delivery inbox")
	secretKey: Uint8Array; // 32-byte X25519 secret key (stays in the winner's daemon)
}

/** Generate an X25519 keypair for sealed-box delivery. */
export function generateSealKeyPair(): SealKeyPair {
	const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
	const secretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
	sodium.crypto_box_keypair(publicKey, secretKey);
	return { publicKey: new Uint8Array(publicKey), secretKey: new Uint8Array(secretKey) };
}

/** A fresh 16-byte salt. */
export function freshSalt(): Uint8Array {
	const b = Buffer.alloc(16);
	sodium.randombytes_buf(b);
	return new Uint8Array(b);
}

/** Commitment a listing publishes: sha256(salt ‖ secret), hex. Binds the listing to the exact secret. */
export function commit(secret: Uint8Array, salt: Uint8Array): string {
	return toHex(sha256(concatBytes(salt, secret)));
}

/** Verify a revealed (secret, salt) matches a published commitment. */
export function verifyCommitment(secret: Uint8Array, salt: Uint8Array, commitment: string): boolean {
	return commit(secret, salt) === commitment;
}

/** Seal `plaintext` to a recipient X25519 public key. Returns hex ciphertext (anonymous sender). */
export function seal(plaintext: Uint8Array, recipientPublicKey: Uint8Array): string {
	const cipher = Buffer.alloc(plaintext.length + sodium.crypto_box_SEALBYTES);
	sodium.crypto_box_seal(cipher, Buffer.from(plaintext), Buffer.from(recipientPublicKey));
	return toHex(cipher);
}

/** Open a sealed ciphertext with the recipient's keypair. Returns plaintext, or null if it doesn't open. */
export function openSealed(cipherHex: string, kp: SealKeyPair): Uint8Array | null {
	const cipher = Buffer.from(fromHex(cipherHex));
	if (cipher.length < sodium.crypto_box_SEALBYTES) return null;
	const out = Buffer.alloc(cipher.length - sodium.crypto_box_SEALBYTES);
	const ok = sodium.crypto_box_seal_open(out, cipher, Buffer.from(kp.publicKey), Buffer.from(kp.secretKey));
	return ok ? new Uint8Array(out) : null;
}

// ── local at-rest encryption (secretbox) for the seller's secret vault ──

/** Derive a 32-byte symmetric key from a passphrase/seed for the local vault. */
export function vaultKey(seed: Uint8Array): Uint8Array {
	return sha256(concatBytes(new TextEncoder().encode("Gavl_secret_vault_v1"), seed));
}

/** Encrypt plaintext at rest with a symmetric key (XSalsa20-Poly1305). Returns hex `nonce‖cipher`. */
export function vaultEncrypt(plaintext: Uint8Array, key: Uint8Array): string {
	const nonce = Buffer.alloc(sodium.crypto_secretbox_NONCEBYTES);
	sodium.randombytes_buf(nonce);
	const cipher = Buffer.alloc(plaintext.length + sodium.crypto_secretbox_MACBYTES);
	sodium.crypto_secretbox_easy(cipher, Buffer.from(plaintext), nonce, Buffer.from(key));
	return toHex(concatBytes(new Uint8Array(nonce), new Uint8Array(cipher)));
}

/** Decrypt a vault blob. Returns plaintext, or null if the key/MAC is wrong. */
export function vaultDecrypt(blobHex: string, key: Uint8Array): Uint8Array | null {
	const blob = fromHex(blobHex);
	const nb = sodium.crypto_secretbox_NONCEBYTES;
	if (blob.length < nb + sodium.crypto_secretbox_MACBYTES) return null;
	const nonce = Buffer.from(blob.subarray(0, nb));
	const cipher = Buffer.from(blob.subarray(nb));
	const out = Buffer.alloc(cipher.length - sodium.crypto_secretbox_MACBYTES);
	const ok = sodium.crypto_secretbox_open_easy(out, cipher, nonce, Buffer.from(key));
	return ok ? new Uint8Array(out) : null;
}
