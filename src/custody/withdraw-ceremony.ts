/**
 * Distributed withdrawal signing (gate #2) — the daemon-facing adapter that signs a
 * real withdrawal tx via the committee ceremony instead of gathering shares.
 *
 * Every committee member independently builds the SAME unsigned withdrawal (tx
 * construction is deterministic from the finalized pending set + fund UTXOs), then
 * co-signs each input through a `SignCoordinator` over the live transport. Each
 * member holds only its own share; only public nonce-commitments + sig-shares cross
 * the wire. They all converge on the identical signed tx — any member can broadcast.
 *
 * Inputs are co-signed SEQUENTIALLY (one ceremony per input; a node runs one signing
 * handler at a time). The per-input `signId` keeps stray messages from other inputs
 * filtered out, so members stay in lockstep.
 *
 * Handles BOTH base-fund-key inputs and per-user DEPOSIT inputs: a deposit input is
 * co-signed for its tweaked deposit key — each member applies the public per-user
 * tweak to its OWN share (deterministic, so they stay consistent) and the ceremony
 * runs over the tweaked package. So the committee can distributedly spend any fund
 * UTXO — base or deposit — without ever gathering shares.
 *
 * LIVENESS: `signWithdrawalWithFailover` wraps this so a single unresponsive member
 * doesn't block a withdrawal — every committee node drives a deterministic quorum
 * rotation in lockstep, retrying with the next quorum until one completes.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { SignCoordinator } from "./sign-coordinator.ts";
import { isCeremonyTimeout } from "./ceremony.ts";
import { quorumForRound } from "./committee.ts";
import { taprootOutputKey } from "./bitcoin.ts";
import { depositOutputKey, depositSigningContext } from "./deposit.ts";
import type { UnsignedWithdrawal } from "./btctx.ts";
import type { PublicPackage, Share } from "./threshold.ts";
import type { GavlNode } from "../sync/node.ts";

export interface CommitteeSigner {
	node: GavlNode;
	signIdBase: string; // unique per withdrawal (e.g. the txid-to-be / a burn id)
	selfId: string; // this node's committee id
	quorum: string[]; // the signing quorum's ids (length ≥ min)
	pub: PublicPackage; // the fund's group public package
	groupPubKey: Uint8Array;
	share: Share; // THIS node's share — never leaves
	timeoutMs?: number; // per-input ceremony budget; omit → wait indefinitely (tests)
}

/**
 * Co-sign `unsigned` with the committee and finalize. Each committee member calls
 * this with the same `unsigned` and its own share; resolves (on every member) with
 * the identical signed tx. Rejects with a CeremonyTimeout if a quorum member doesn't
 * answer within `timeoutMs`, or throws if a produced signature doesn't verify.
 */
export async function signWithdrawalDistributed(unsigned: UnsignedWithdrawal, s: CommitteeSigner): Promise<{ hex: string; txid: string }> {
	for (let i = 0; i < unsigned.sighashes.length; i++) {
		const owner = unsigned.owners[i];
		// Base input → this node's share + the fund key. Deposit input → this node's
		// TWEAKED share + tweaked package + the deposit key (every member tweaks
		// identically from the public per-user tweak).
		const ctx = owner === undefined ? { share: s.share, pub: s.pub } : depositSigningContext(s.groupPubKey, s.pub, owner, s.share);
		const expectedKey = owner === undefined ? taprootOutputKey(s.groupPubKey) : depositOutputKey(s.groupPubKey, owner);
		const coord = new SignCoordinator(s.node, {
			signId: `${s.signIdBase}:${i}`,
			selfId: s.selfId,
			quorum: s.quorum,
			pub: ctx.pub,
			share: ctx.share,
			message: unsigned.sighashes[i],
			timeoutMs: s.timeoutMs,
		});
		const sig = await coord.start(); // resolves once the quorum's shares aggregate
		if (!schnorr.verify(sig, unsigned.sighashes[i], expectedKey)) throw new Error(`committee signature invalid for input ${i}`);
		unsigned.tx.updateInput(i, { tapKeySig: sig });
	}
	unsigned.tx.finalize();
	return { hex: unsigned.tx.hex, txid: unsigned.tx.id };
}

export interface FailoverSigner {
	node: GavlNode;
	signIdBase: string; // unique per withdrawal
	selfId: string; // this node's committee id
	committee: string[]; // the FULL committee (any min-subset is a valid quorum)
	min: number; // signing threshold
	pub: PublicPackage;
	groupPubKey: Uint8Array;
	share: Share; // THIS node's share
	timeoutMs: number; // per-round budget
	maxRounds?: number; // default committee.length
}

/**
 * Co-sign a withdrawal with quorum failover. Run by EVERY committee member: each
 * round, `quorumForRound` picks the same `min`-member quorum on every node; members
 * in it co-sign (with a timeout), members outside it wait out the round so the whole
 * committee advances in lockstep. If the quorum can't complete (someone's down), all
 * nodes roll to the next round's quorum. Returns the signed tx (on every node that
 * was in the winning quorum), or null if no quorum could be formed in `maxRounds`.
 *
 * `buildUnsigned` is re-invoked each round because finalizing a PSBT consumes it —
 * tx construction is deterministic, so every round/every node rebuilds identical bytes.
 */
export async function signWithdrawalWithFailover(buildUnsigned: () => UnsignedWithdrawal, s: FailoverSigner): Promise<{ hex: string; txid: string } | null> {
	const rounds = s.maxRounds ?? s.committee.length;
	for (let round = 0; round < rounds; round++) {
		const quorum = quorumForRound(s.committee, s.min, round);
		if (quorum.includes(s.selfId)) {
			try {
				return await signWithdrawalDistributed(buildUnsigned(), {
					node: s.node,
					signIdBase: `${s.signIdBase}#${round}`, // round in the id → no cross-round message bleed
					selfId: s.selfId,
					quorum,
					pub: s.pub,
					groupPubKey: s.groupPubKey,
					share: s.share,
					timeoutMs: s.timeoutMs,
				});
			} catch (e) {
				if (!isCeremonyTimeout(e)) throw e; // a real signing fault → surface it; a timeout → rotate
			}
		} else {
			// Bystander this round: wait out the round so we rejoin in lockstep if it fails.
			await new Promise((r) => setTimeout(r, s.timeoutMs));
		}
	}
	return null; // too many members down to form any quorum within maxRounds
}
