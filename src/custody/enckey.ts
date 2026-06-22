/**
 * Per-member encryption keys for verifiable encrypted resharing (docs/pvss-reshare.md, phase 1).
 *
 * A committee id IS an Ed25519 *signing* key (the producer pubkey). Verifiable encrypted resharing
 * seals each sub-share to a member's X25519 key, so every member needs a companion *encryption* key —
 * and other members must be able to trust "this X25519 key really belongs to committee member <id>".
 *
 * This module:
 *  - DERIVES the X25519 encryption key deterministically from the node's Ed25519 producer seed (no new
 *    persisted secret; the same seed always yields the same encryption key);
 *  - BINDS the public encryption key to the committee id with an Ed25519 signature, so anyone holding the
 *    id (a public pubkey) can verify the binding without trusting the announcer;
 *  - keeps a REGISTRY of peers' encryption keys, admitting only announcements whose binding checks out.
 *
 * Domain-separated from anchor signing and ceremony auth: the producer key is reused for ECDH, but the
 * derived X25519 key is a distinct value and the binding signature covers a dedicated domain tag.
 */

import * as ed from "../det/ed25519.ts";
import * as x25519 from "../det/x25519.ts";
import { sha256, concatBytes, fromHex, toHex } from "../det/canonical.ts";

const DERIVE_DOMAIN = new TextEncoder().encode("gavl/pvss/enckey/derive/v1");
const BIND_DOMAIN = new TextEncoder().encode("gavl/pvss/enckey/bind/v1");

/** This node's X25519 encryption keypair, derived deterministically from its Ed25519 producer seed. */
export function deriveEncKey(ed25519Seed: Uint8Array): x25519.KeyPair {
	return x25519.keyPairFromSeed(sha256(concatBytes(DERIVE_DOMAIN, ed25519Seed)));
}

/** Sign an X25519 public key with the Ed25519 producer key → a binding anyone can verify against the id. */
export function bindEncKey(ed25519Seed: Uint8Array, encPub: Uint8Array): string {
	return toHex(ed.sign(ed25519Seed, concatBytes(BIND_DOMAIN, encPub)));
}

/** Verify `encPub` is bound to committee id `idHex` (an Ed25519 pubkey hex) by `bindingHex`. Pure — needs
 *  no secret, so any node can gate inbound announcements. */
export function verifyEncKeyBinding(idHex: string, encPub: Uint8Array, bindingHex: string): boolean {
	try {
		return ed.verify(fromHex(idHex), concatBytes(BIND_DOMAIN, encPub), fromHex(bindingHex));
	} catch {
		return false; // malformed id / binding → not authentic
	}
}

/** What a member gossips so peers learn its (verified) encryption key. */
export interface EncKeyAnnounce {
	id: string; // the member's committee id (Ed25519 pubkey hex)
	encPub: string; // its X25519 encryption public key (hex)
	binding: string; // Ed25519 signature over the encPub, by `id`
}

/** Build this node's announcement from its producer seed + committee id. */
export function announceEncKey(ed25519Seed: Uint8Array, idHex: string): EncKeyAnnounce {
	const k = deriveEncKey(ed25519Seed);
	return { id: idHex, encPub: toHex(k.publicKey), binding: bindEncKey(ed25519Seed, k.publicKey) };
}

/** A registry of peers' verified X25519 encryption keys. Admits only announcements whose binding checks
 *  out, so `encKeyOf` (fed to pvss.dealVerifiable) only ever returns keys provably owned by their id. */
export class EncKeyRegistry {
	private readonly keys = new Map<string, Uint8Array>(); // committee id → verified X25519 pub

	/** Learn a peer's key iff its binding verifies. Returns true if admitted. */
	learn(a: EncKeyAnnounce): boolean {
		let encPub: Uint8Array;
		try {
			encPub = fromHex(a.encPub);
		} catch {
			return false;
		}
		if (encPub.length !== 32 || !verifyEncKeyBinding(a.id, encPub, a.binding)) return false;
		this.keys.set(a.id, encPub);
		return true;
	}

	get(id: string): Uint8Array | undefined {
		return this.keys.get(id);
	}

	has(id: string): boolean {
		return this.keys.has(id);
	}

	/** Which of `ids` we do NOT yet hold a verified key for (e.g. before a reshare can seal to them). */
	missing(ids: string[]): string[] {
		return ids.filter((id) => !this.keys.has(id));
	}
}
