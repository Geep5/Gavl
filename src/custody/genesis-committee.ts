/**
 * Hardcoded genesis committee (TESTNET/DEV) — a DETERMINISTIC FROST committee derived
 * from a single seed, mirroring the hardcoded genesis block.
 *
 * WHY THIS EXISTS — design tradeoff (see README "Genesis committee: a deliberate tradeoff"):
 *   The real committee is formed by a LIVE distributed DKG at the genesis epoch
 *   (custody/rotation.ts + dkg-coordinator.ts). That is the secure production path, but
 *   it is a multi-node ceremony that must complete on the wire before the network can
 *   custody anything — and it is brittle to bootstrap (a single non-completing member
 *   wedges it; see the DKG-robustness research). For TESTNET/DEV we sidestep it: the
 *   committee is a PURE FUNCTION of the network label (exactly like genesis.ts), so every
 *   node DERIVES the identical committee locally — no ceremony on the wire. Each node takes
 *   ONE share by index (GAVL_COMMITTEE_INDEX); the group key is published into consensus
 *   state and lives there ("continues in the RAM system" like the genesis block itself).
 *
 *   THE TRADEOFF / WHY IT IS TESTNET-ONLY: the seed is PUBLIC (it is in this repo), so the
 *   derived key is reconstructable by anyone who runs this — the custody is NOT trustless.
 *   That is the accepted cost of a zero-config dev default ("unsecure, but anyone can run it
 *   on 3 nodes"). MAINNET MUST use the live distributed DKG, where no one ever holds the
 *   whole key. The daemon gates this off mainnet.
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import { keyPairFromSeed } from "../det/ed25519.ts";
import { sha256, concatBytes, u32be, toHex } from "../det/canonical.ts";
import { DkgSession } from "./dkg-session.ts";
import type { Round1Message, Round2Message } from "./dkg-session.ts";
import type { Share, PublicPackage } from "./threshold.ts";

const DOMAIN = "gavl-genesis-committee-v1";
/** Default dev committee shape: 2-of-3. */
export const GENESIS_COMMITTEE_SIZE = 3;
export const GENESIS_COMMITTEE_MIN = 2;

/** Deterministic byte stream from a seed (sha256 counter) — feeds FROST's polynomial sampling
 *  so round 1 is reproducible (the same trick dkg-coordinator uses for retry-determinism). */
function seededRng(seed: Uint8Array): (len: number) => Uint8Array {
	let counter = 0;
	let buf: Uint8Array = new Uint8Array(0);
	return (len: number) => {
		const out = new Uint8Array(len);
		let off = 0;
		while (off < len) {
			if (buf.length === 0) buf = sha256(concatBytes(seed, u32be(counter++)));
			const take = Math.min(buf.length, len - off);
			out.set(buf.subarray(0, take), off);
			buf = buf.subarray(take);
			off += take;
		}
		return out;
	};
}

/** The committee seed — a pure function of the network label, so each network gets its own. */
function committeeSeed(network: string): Uint8Array {
	return sha256(concatBytes(Buffer.from(DOMAIN, "utf8"), Buffer.from(network, "utf8")));
}

/** One committee member's full install material. `secretKey` is the member's ed25519 committee
 *  identity (signs ceremony messages); `share` is its FROST threshold share. */
export interface GenesisCommitteeMember {
	selfId: string; // committee id = hex(member pubkey)
	secretKey: Uint8Array; // member's ed25519 private key (ceremony auth)
	share: Share; // this member's FROST share
	pub: PublicPackage; // group public package (same for all members)
	groupPubKey: Uint8Array; // fund group key (→ Taproot address)
	participants: string[]; // all member ids, in index order
	min: number; // signing threshold
}

/**
 * Derive the full deterministic committee from the network seed: member identities + a SEEDED
 * in-process FROST DKG that yields each member's share + the shared group key. Pure — every node
 * computes the byte-identical result, so the committee needs no ceremony on the wire.
 *
 * Shares are keyed by `FROST.Identifier.derive(memberId)` to match sign-coordinator's lookup, so
 * the output is a drop-in for the live-DKG path's stored share + thresholdSign.
 */
export function deriveGenesisCommittee(network: string, min = GENESIS_COMMITTEE_MIN, max = GENESIS_COMMITTEE_SIZE): GenesisCommitteeMember[] {
	const seed = committeeSeed(network);
	// 1) Member identities: one ed25519 keypair per seat, deterministically from the seed.
	const keys = Array.from({ length: max }, (_, i) => keyPairFromSeed(sha256(concatBytes(seed, Buffer.from("key", "utf8"), u32be(i)))));
	const ids = keys.map((k) => toHex(k.publicKey));
	const fids = ids.map((id) => FROST.Identifier.derive(id)); // == sign-coordinator's derive(id)
	// 2) Seeded in-process DKG: each seat runs a DkgSession keyed by its derived FROST id, with a
	//    deterministic round-1 polynomial → reproducible shares + one shared group key.
	const sessions = fids.map((fid) => new DkgSession(fid, { min, max }));
	const r1: Round1Message[] = sessions.map((s, i) => s.round1(seededRng(sha256(concatBytes(seed, Buffer.from("dkg", "utf8"), u32be(i))))));
	const mailbox: Record<string, Round2Message[]> = {};
	for (const fid of fids) mailbox[fid] = [];
	sessions.forEach((s, i) => {
		const shares = s.round2(r1.filter((_, j) => j !== i));
		for (const recipientFid of Object.keys(shares)) mailbox[recipientFid].push(shares[recipientFid]);
	});
	sessions.forEach((s, i) => s.round3(r1.filter((_, j) => j !== i), mailbox[fids[i]]));
	// Canonical group package = seat 0's (deterministic) so every node stores the byte-identical pub; it
	// holds every seat's verifying share, so any member signs against it.
	const pub = sessions[0].pub();
	const groupPubKey = sessions[0].groupPubKey();
	return sessions.map((s, i) => ({ selfId: ids[i], secretKey: keys[i].privateKey, share: s.share(), pub, groupPubKey, participants: ids, min }));
}

/** This node's committee member by index (GAVL_COMMITTEE_INDEX). Throws if out of range. */
export function genesisCommitteeMember(network: string, index: number, min = GENESIS_COMMITTEE_MIN, max = GENESIS_COMMITTEE_SIZE): GenesisCommitteeMember {
	if (!Number.isInteger(index) || index < 0 || index >= max) throw new Error(`genesis committee: index ${index} out of range [0,${max})`);
	return deriveGenesisCommittee(network, min, max)[index];
}
