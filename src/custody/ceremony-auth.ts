/**
 * Ceremony message authentication (gate #2, scale hardening).
 *
 * Ceremony messages carry a self-declared `from` (the sender's committee id). At a
 * small full mesh that's tolerable — you know your handful of peers. At 100+ nodes,
 * where committee members rendezvous on an open sub-swarm topic, ANY node can connect
 * and claim `from: <honest member>` — and since a DKG round-2 SECRET share is routed
 * to the connection that member's round-1 arrived on, an impersonator could siphon the
 * share meant for the real member. So every ceremony message must be SIGNED by the key
 * its `from` names, and verified on receipt.
 *
 * A committee id IS an Ed25519 producer pubkey (the same key the node signs anchors
 * with), so authentication is just: verify the message signature against `from`. The
 * signature covers the whole payload (session/signId, from, to, content) — so it also
 * binds the recipient and content, preventing a relay from redirecting a share or
 * tampering with a commitment.
 *
 * Optional: a coordinator with no auth (the in-process tests, where ids are plain
 * strings, not pubkeys) behaves exactly as before. The daemon always supplies it.
 */

import * as ed from "../det/ed25519.ts";
import { canonicalBytes, fromHex, toHex } from "../det/canonical.ts";

export interface CeremonyAuth {
	/** Attach a signature over the payload (signed as the holder's committee id). */
	stamp<T extends object>(m: T): T & { sig: string };
	/** True if `m.sig` is a valid signature over `m` (sans sig) by the key `m.from` names. */
	ok<T extends { from: string; sig?: string }>(m: T): boolean;
}

function withoutSig<T extends object>(m: T): Omit<T, "sig"> {
	const { sig: _drop, ...rest } = m as T & { sig?: unknown };
	return rest as Omit<T, "sig">;
}

/** Auth backed by a producer keypair: signs as this node's id, verifies anyone's. */
export function makeCeremonyAuth(privateKey: Uint8Array): CeremonyAuth {
	return {
		stamp: (m) => ({ ...m, sig: toHex(ed.sign(privateKey, canonicalBytes(withoutSig(m)))) }),
		ok: (m) => verifyCeremony(m),
	};
}

/** Verify a ceremony message's signature against its `from` (a pubkey hex). Pure — no
 *  key needed, so a node can gate inbound messages without holding any committee key. */
export function verifyCeremony<T extends { from: string; sig?: string }>(m: T): boolean {
	if (typeof m.sig !== "string") return false;
	try {
		return ed.verify(fromHex(m.from), canonicalBytes(withoutSig(m)), fromHex(m.sig));
	} catch {
		return false; // malformed from/sig → not authentic
	}
}
