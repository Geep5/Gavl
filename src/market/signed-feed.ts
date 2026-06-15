/**
 * Generic signed price feed — the Pyth model, generalized to ANY source.
 *
 * Pyth proves a price is genuine because the SOURCE (Wormhole's guardians) signs it, so
 * anyone can relay it and the fold just verifies the signature — no reporter to trust.
 * This is the open version of that: a source signs its reading with an Ed25519 key, and
 * a channel commits to that key (`label::signed::<sourcePubkey>`). ANYONE relays a signed
 * update on-chain; the fold verifies the signature against the committed key, so Gavl
 * knows the data genuinely came from that source — not from whoever posted it.
 *
 * "Use any endpoint" works by wrapping an unsigned API in a tiny signer you run (its key
 * becomes the market's trust anchor); Pyth (market/pyth.ts) is just a pre-built scheme.
 *
 * Pure + deterministic (no network): the fold verifies bytes, never fetches. The relayer
 * is untrusted — a forged or tampered update simply fails verification.
 */

import * as ed from "../det/ed25519.ts";
import { sha256, canonicalBytes, concatBytes, fromHex, toHex } from "../det/canonical.ts";

/** The on-chain (wire) form of a signed reading. `price` is a decimal string so it
 *  round-trips through JSON without losing bigint precision. */
export interface SignedUpdate {
	price: string; // integer price; real value = price · 10^expo
	expo: number; // decimal exponent (e.g. -8)
	publishTime: number; // unix seconds — newest wins (replay/staleness guard)
	sig: string; // Ed25519 signature (hex) by the SOURCE key over the reading
}

const DOMAIN = new TextEncoder().encode("gavl-signed-feed-v1");

/** The bytes a source signs — domain-separated + canonical, so every node hashes
 *  identically and a signed-feed signature can't be replayed as anything else. */
function digestOf(price: bigint, expo: number, publishTime: number): Uint8Array {
	return sha256(concatBytes(DOMAIN, canonicalBytes({ price: price.toString(), expo, publishTime })));
}

/** A SOURCE signs a reading with its private key → a relayable update. Run this inside a
 *  signer that wraps your data endpoint (see the feed-signer utility). */
export function signReading(price: bigint, expo: number, publishTime: number, sourcePriv: Uint8Array): SignedUpdate {
	return { price: price.toString(), expo, publishTime, sig: toHex(ed.sign(sourcePriv, digestOf(price, expo, publishTime))) };
}

/** The FOLD verifies an update against the channel's committed source pubkey. Returns the
 *  reading iff the signature is genuinely the source's; null otherwise. Never throws — an
 *  untrusted relayer can't crash the fold with a malformed blob. */
export function verifySignedReading(update: unknown, sourcePubHex: string): { price: bigint; expo: number; publishTime: number } | null {
	try {
		const u = update as Partial<SignedUpdate>;
		if (typeof u?.sig !== "string" || typeof u.price !== "string" || typeof u.expo !== "number" || typeof u.publishTime !== "number") return null;
		const price = BigInt(u.price);
		if (!ed.verify(fromHex(sourcePubHex), digestOf(price, u.expo, u.publishTime), fromHex(u.sig))) return null;
		return { price, expo: u.expo, publishTime: u.publishTime };
	} catch {
		return null; // malformed → reject, never throw
	}
}
