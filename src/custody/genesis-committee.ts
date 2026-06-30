/**
 * Trusted-dealer genesis committee (testnet/dev) — the committee is MINTED ONCE with fresh randomness,
 * the secret shares are handed to the nodes OUT-OF-BAND, and only the PUBLIC group key lives in this repo.
 *
 * WHY THIS SHAPE — design tradeoff (see README "Genesis committee"):
 *   The real committee is formed by a LIVE distributed DKG (custody/rotation.ts), which is brittle to
 *   bootstrap (n-of-n: one stale member wedges it). For TESTNET/DEV we instead run the keygen ONCE on a
 *   single machine (`npm run committee:setup` → mintCommittee), then DISTRIBUTE each seat's share to its
 *   node privately. The repo carries ONLY `GENESIS_COMMITTEE_PUBKEY` — a public group key, which can't
 *   sign anything and can't be reversed into the private key. NOTHING exploitable is committed: a fresh
 *   clone has the fund address and no way to spend.
 *
 *   THE TRADEOFF: the one machine that runs the setup transiently sees the whole key while it cuts the
 *   shares (a "trusted dealer"). You delete it afterward and trust that one-time setup — a standard
 *   trusted-setup assumption, fine for an operator standing up their own nodes. MAINNET keeps the live
 *   distributed DKG, where no machine ever sees the whole key; the daemon gates this off mainnet.
 */

import { schnorr_FROST as FROST } from "@noble/curves/secp256k1.js";
import { generateKeyPair } from "../det/ed25519.ts";
import { fromHex, toHex } from "../det/canonical.ts";
import { DkgSession } from "./dkg-session.ts";
import type { Round1Message, Round2Message } from "./dkg-session.ts";
import type { Share, PublicPackage } from "./threshold.ts";

/** Default dev committee shape: 2-of-3. */
export const GENESIS_COMMITTEE_SIZE = 3;
export const GENESIS_COMMITTEE_MIN = 2;

/**
 * PUBLIC group keys, per network label — the ONLY committee material in the repo. Each is the output of a
 * one-time `npm run committee:setup`; paste the printed key here. A public key (33-byte compressed secp256k1,
 * hex) — it identifies the fund but can't sign. Leave a network out and it falls back to the live DKG.
 *
 *   "<network label>": "<group key hex from the setup>",
 */
export const GENESIS_COMMITTEE_PUBKEY: Record<string, string> = {
	// e.g. "BTC-USD::pyth::e62df6c8…": "02ab…",  ← filled in after `npm run committee:setup`
};

/** The public group key for a network, or null (→ run the live DKG instead). From `GAVL_COMMITTEE_PUBKEY`
 *  (env, handy for testing) or the committed `GENESIS_COMMITTEE_PUBKEY` map. Public — safe either way. */
export function genesisCommitteeKey(network: string): Uint8Array | null {
	const hex = process.env.GAVL_COMMITTEE_PUBKEY || GENESIS_COMMITTEE_PUBKEY[network];
	return hex ? fromHex(hex) : null;
}

/** One minted committee member: its ed25519 committee identity (signs ceremony messages) + its FROST share. */
export interface MintedMember {
	selfId: string; // committee id = hex(member pubkey)
	secretKey: Uint8Array; // member's ed25519 private key (ceremony auth) — distributed out-of-band
	share: Share; // this member's FROST share — distributed out-of-band
}

export interface MintedCommittee {
	groupPubKey: Uint8Array; // the PUBLIC fund key → Taproot address. The only part that goes in the repo.
	pub: PublicPackage; // canonical group public package (same for every member)
	participants: string[]; // member ids in seat order
	min: number; // signing threshold
	members: MintedMember[]; // per-seat secrets — handed to the nodes, NEVER committed
}

/**
 * Mint a fresh `min`-of-`max` committee with REAL randomness (run ONCE, on one machine, by the setup
 * script). Generates `max` ed25519 committee keypairs and runs the FROST DKG in-process; shares are keyed
 * by `FROST.Identifier.derive(memberId)` so they're a drop-in for sign-coordinator. Because it's random
 * (no seed), the result is NOT reproducible — the secrets exist only in this output, to be distributed.
 */
export function mintCommittee(min = GENESIS_COMMITTEE_MIN, max = GENESIS_COMMITTEE_SIZE): MintedCommittee {
	const keys = Array.from({ length: max }, () => generateKeyPair()); // fresh randomness — NOT seeded
	const ids = keys.map((k) => toHex(k.publicKey));
	const fids = ids.map((id) => FROST.Identifier.derive(id)); // == sign-coordinator's derive(id)
	const sessions = fids.map((fid) => new DkgSession(fid, { min, max }));
	const r1: Round1Message[] = sessions.map((s) => s.round1()); // random round-1 polynomial
	const mailbox: Record<string, Round2Message[]> = {};
	for (const fid of fids) mailbox[fid] = [];
	sessions.forEach((s, i) => {
		const shares = s.round2(r1.filter((_, j) => j !== i));
		for (const recipientFid of Object.keys(shares)) mailbox[recipientFid].push(shares[recipientFid]);
	});
	sessions.forEach((s, i) => s.round3(r1.filter((_, j) => j !== i), mailbox[fids[i]]));
	const pub = sessions[0].pub(); // canonical group package — holds every seat's verifying share
	const groupPubKey = sessions[0].groupPubKey();
	return {
		groupPubKey,
		pub,
		participants: ids,
		min,
		members: sessions.map((s, i) => ({ selfId: ids[i], secretKey: keys[i].privateKey, share: s.share() })),
	};
}
