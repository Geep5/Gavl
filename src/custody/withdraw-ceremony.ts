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
 * SCOPE: BASE-fund-key inputs (the consolidated fund). Per-user DEPOSIT inputs need
 * distributed TWEAKED signing (each signer applies the public deposit tweak to its
 * share before the ceremony) — the immediate follow-on; we reject them here rather
 * than produce a wrong signature.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { SignCoordinator } from "./sign-coordinator.ts";
import { taprootOutputKey } from "./bitcoin.ts";
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
	const fundKey = taprootOutputKey(s.groupPubKey);
	for (let i = 0; i < unsigned.sighashes.length; i++) {
		if (unsigned.owners[i] !== undefined) throw new Error(`input ${i} is a per-user deposit — distributed tweaked signing is the next increment`);
		const coord = new SignCoordinator(s.node, {
			signId: `${s.signIdBase}:${i}`,
			selfId: s.selfId,
			quorum: s.quorum,
			pub: s.pub,
			share: s.share,
			message: unsigned.sighashes[i],
		});
		const sig = await coord.start(); // resolves once the quorum's shares aggregate
		if (!schnorr.verify(sig, unsigned.sighashes[i], fundKey)) throw new Error(`committee signature invalid for input ${i}`);
		unsigned.tx.updateInput(i, { tapKeySig: sig });
	}
	unsigned.tx.finalize();
	return { hex: unsigned.tx.hex, txid: unsigned.tx.id };
}
