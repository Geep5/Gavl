/**
 * Distributed DKG session (gate #2) — one PARTICIPANT, not an orchestrator.
 *
 * `generateFundKeyDKG` (threshold.ts) runs all three DKG rounds inside one process,
 * so that process transiently touches every participant's secret. That's fine for
 * the testnet single-operator fund, but it is NOT distributed custody. This module
 * is the real thing: each node runs its own `DkgSession`, and a session only ever
 * holds (a) its OWN secret polynomial and (b) the point-to-point shares addressed
 * to it. It never sees another participant's polynomial and never computes the
 * group private key. The key is born distributed; no one — not even at setup — ever
 * holds it whole. (This also closes gate #4: there's no seed to keep secret.)
 *
 * Message flow (driven by the caller / the gossip mesh, never by a central holder):
 *   round1()  → BROADCAST a public commitment + proof-of-knowledge to all peers
 *   round2(peerR1)  → produce a SECRET share addressed to each other peer (send
 *                     point-to-point; in production, encrypted to the recipient)
 *   round3(peerR1, sharesForMe) → combine peers' commitments + the shares sent to me
 *                                 into MY final signing share + the group public key
 *
 * After round3 each node holds only its own `Share`; a quorum later threshold-signs
 * without anyone reassembling the key (thresholdSign / a future signing session).
 *
 * Wraps @noble/curves' audited FROST DKG; this module is the per-participant state
 * machine + message typing. NOT yet wired to the live gossip layer (next increment).
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import type { PublicPackage, Share } from "./threshold.ts";

/** Broadcast in round 1: the participant's commitment + proof-of-knowledge. Public. */
export type Round1Message = ReturnType<typeof FROST.DKG.round1>["public"];
/** Sent point-to-point in round 2: a secret share for one specific recipient. */
export type Round2Message = ReturnType<typeof FROST.DKG.round2>[string];

export interface Signers {
	min: number;
	max: number;
}

export class DkgSession {
	/** This participant's FROST identifier (serialized form used as the routing key). */
	readonly id: string;
	private readonly signers: Signers;
	// SECRETS that never leave this node:
	private r1secret: ReturnType<typeof FROST.DKG.round1>["secret"] | null = null;
	private finalShare: Share | null = null;
	private groupPub: PublicPackage | null = null;
	private step: 0 | 1 | 2 | 3 = 0;

	/** `index` is this participant's seat number (1..max). */
	constructor(index: number, signers: Signers) {
		this.signers = signers;
		this.id = FROST.Identifier.fromNumber(index);
	}

	/** Round 1: sample our polynomial, stash the secret, return the public package to BROADCAST. */
	round1(): Round1Message {
		if (this.step !== 0) throw new Error("dkg: round1 already done");
		const { public: pub, secret } = FROST.DKG.round1(this.id, this.signers);
		this.r1secret = secret;
		this.step = 1;
		return pub;
	}

	/**
	 * Round 2: given every OTHER participant's round-1 public package, produce the
	 * secret share to send to each of them (point-to-point). Returns a map
	 * recipientId → share. We validated each peer's proof-of-knowledge here (FROST).
	 */
	round2(peerR1: Round1Message[]): Record<string, Round2Message> {
		if (this.step !== 1 || !this.r1secret) throw new Error("dkg: round1 must precede round2");
		if (peerR1.length !== this.signers.max - 1) throw new Error(`dkg: expected ${this.signers.max - 1} peer round1 packages`);
		const out = FROST.DKG.round2(this.r1secret, peerR1);
		this.step = 2;
		return out;
	}

	/**
	 * Round 3: combine the peers' round-1 commitments with the round-2 shares sent TO
	 * us → our final signing share + the group public package. After this we hold only
	 * our own share; the group secret was never assembled anywhere.
	 */
	round3(peerR1: Round1Message[], sharesForMe: Round2Message[]): { groupPubKey: Uint8Array; id: string } {
		if (this.step !== 2 || !this.r1secret) throw new Error("dkg: round2 must precede round3");
		const res = FROST.DKG.round3(this.r1secret, peerR1, sharesForMe);
		this.groupPub = res.public as PublicPackage;
		this.finalShare = res.secret as Share;
		this.r1secret = null; // polynomial no longer needed — drop it
		this.step = 3;
		return { groupPubKey: this.groupPub.commitments[0], id: this.id };
	}

	/** This node's final threshold share (stays local; used to sign on THIS node only). */
	share(): Share {
		if (!this.finalShare) throw new Error("dkg: not complete");
		return this.finalShare;
	}

	/** The group public package (same on every node) — group key, verifying shares, (min,max). */
	pub(): PublicPackage {
		if (!this.groupPub) throw new Error("dkg: not complete");
		return this.groupPub;
	}

	/** The fund's group public key (drives the Taproot address). */
	groupPubKey(): Uint8Array {
		return this.pub().commitments[0];
	}

	done(): boolean {
		return this.step === 3;
	}
}

/**
 * Drive a full distributed DKG across `max` independent sessions by ROUTING messages
 * between them — no central object ever holds all secrets (each session keeps its own).
 * This is the orchestration the gossip mesh will perform in production; provided here
 * so callers/tests can run the protocol. Returns each participant's session (each
 * holding only its own share) + the agreed group key.
 *
 * Throws if the sessions disagree on the group key (a sign of a faulty/cheating peer).
 */
export function runDistributedDkg(min: number, max: number): { sessions: DkgSession[]; groupPubKey: Uint8Array } {
	const sessions = Array.from({ length: max }, (_, i) => new DkgSession(i + 1, { min, max }));

	// Round 1: each broadcasts its public package.
	const r1: Record<string, Round1Message> = {};
	for (const s of sessions) r1[s.id] = s.round1();

	// Round 2: each produces point-to-point shares for the others. Route them into
	// per-recipient mailboxes — a share for X is delivered only to X.
	const mailbox: Record<string, Round2Message[]> = {};
	for (const s of sessions) mailbox[s.id] = [];
	for (const s of sessions) {
		const peerR1 = sessions.filter((o) => o.id !== s.id).map((o) => r1[o.id]);
		const shares = s.round2(peerR1);
		for (const recipientId of Object.keys(shares)) mailbox[recipientId].push(shares[recipientId]);
	}

	// Round 3: each combines peers' round1 + the shares delivered to it → its final share.
	let agreed: Uint8Array | null = null;
	for (const s of sessions) {
		const peerR1 = sessions.filter((o) => o.id !== s.id).map((o) => r1[o.id]);
		const { groupPubKey } = s.round3(peerR1, mailbox[s.id]);
		if (agreed === null) agreed = groupPubKey;
		else if (Buffer.compare(agreed, groupPubKey) !== 0) throw new Error("dkg: participants disagree on the group key");
	}
	return { sessions, groupPubKey: agreed! };
}
