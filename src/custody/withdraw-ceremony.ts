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
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { SignCoordinator } from "./sign-coordinator.ts";
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
}

/**
 * Co-sign `unsigned` with the committee and finalize. Each committee member calls
 * this with the same `unsigned` and its own share; resolves (on every member) with
 * the identical signed tx. Throws on a per-user deposit input (not yet supported)
 * or if a produced signature doesn't verify against the fund key.
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
		});
		const sig = await coord.start(); // resolves once the quorum's shares aggregate
		if (!schnorr.verify(sig, unsigned.sighashes[i], expectedKey)) throw new Error(`committee signature invalid for input ${i}`);
		unsigned.tx.updateInput(i, { tapKeySig: sig });
	}
	unsigned.tx.finalize();
	return { hex: unsigned.tx.hex, txid: unsigned.tx.id };
}
