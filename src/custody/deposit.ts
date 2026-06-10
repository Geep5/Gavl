/**
 * Per-identity deposit addresses — the fix for deposit front-running.
 *
 * THE PROBLEM: with one shared fund address, a deposit is just BTC paid to the
 * fund, and `claimDeposit(txid, me)` credits whoever calls first (deduped only by
 * outpoint). In a multi-party network that's a clean steal: watch the fund
 * address, see a deposit confirm, claim it to your own pubkey before the real
 * depositor. Nothing on-chain ties the payment to a Gavl identity.
 *
 * THE FIX: every user gets a DISTINCT Taproot deposit address, derived
 * deterministically from (fund key, their Gavl pubkey):
 *
 *     t_user        = H("gavl/deposit/v1" ‖ fund_xonly ‖ user_pubkey)  (mod n)
 *     depositKey    = fund_output_key  +  t_user · G
 *     depositAddr   = P2TR(depositKey)
 *
 * The BTC physically lands at an address only that user's pubkey derives, so the
 * binding is in the immutable Bitcoin transaction, not a front-runnable claim. A
 * claim is valid only if the deposit paid `depositAddress(claimer)` — an attacker
 * claiming someone else's txid derives a DIFFERENT address the tx never paid, so
 * their claim fails. Front-running is impossible by construction.
 *
 * The per-user tweak `t_user` is PUBLIC, so the fund's threshold committee can
 * still spend each deposit: tweak every share by t_user (the sum stays q + t via
 * Lagrange) and FROST-sign for `depositKey`. Verified against Bitcoin's BIP340
 * verifier for both Y-parities — deposits are never stuck. (See signDepositSpend.)
 */

import { schnorr_FROST as FROST, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { taprootAddress, taprootScriptPubKey } from "./bitcoin.ts";
import type { Network } from "./bitcoin.ts";
import { thresholdSign } from "./threshold.ts";
import type { FundKey, PublicPackage, Share } from "./threshold.ts";

const Pt = secp256k1.Point;
const Fn = FROST.utils.Fn;
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const DOMAIN = new TextEncoder().encode("gavl/deposit/v1");

/** x-only (32b) of a key, for the domain hash. */
function xonly(fundGroupKey: Uint8Array): Uint8Array {
	return fundGroupKey.length === 33 ? fundGroupKey.slice(1) : fundGroupKey;
}

/** The per-user additive tweak scalar t_user, bound to the fund + the user's pubkey.
 *  Takes the FULL 33-byte fund group key (the point's parity matters downstream). */
export function depositTweak(fundGroupKey: Uint8Array, userPubHex: string): bigint {
	const userPub = Uint8Array.from(Buffer.from(userPubHex, "hex"));
	const h = sha256(new Uint8Array([...DOMAIN, ...xonly(fundGroupKey), ...userPub]));
	return Fn.create(BigInt("0x" + hex(h))); // reduce into the scalar field
}

/**
 * The user's x-only Taproot deposit key: (raw fund group key point) + t_user·G.
 * Derived from the FULL group key so the point parity matches what `signDepositSpend`
 * signs against — deriving from the x-only-only would silently use a different point
 * when the fund key is odd-Y, producing addresses whose spends don't verify.
 */
export function depositOutputKey(fundGroupKey: Uint8Array, userPubHex: string): Uint8Array {
	if (fundGroupKey.length !== 33) throw new Error("depositOutputKey needs the full 33-byte fund group key");
	const Q = Pt.fromHex(hex(fundGroupKey));
	const t = depositTweak(fundGroupKey, userPubHex);
	return Q.add(Pt.BASE.multiply(t)).toBytes(true).slice(1); // x-only (32 bytes)
}

/** The user's Bitcoin deposit address (bech32m P2TR). Deterministic; only this user
 *  derives it, so a deposit to it is bound to this user. */
export function depositAddress(fundGroupKey: Uint8Array, userPubHex: string, network: Network = "mainnet"): string {
	return taprootAddress(depositOutputKey(fundGroupKey, userPubHex), network);
}

/** The P2TR scriptPubKey of a user's deposit address (for watching / building spends). */
export function depositScriptPubKey(fundGroupKey: Uint8Array, userPubHex: string): Uint8Array {
	return taprootScriptPubKey(depositOutputKey(fundGroupKey, userPubHex));
}

// ── spending a per-user deposit (tweaked FROST signing) ──────────

/** Tweak a key share by t (x_i → x_i + t). Σλ_i(x_i+t) = q + t, so the quorum now
 *  holds shares of the deposit key's secret. Negated if the deposit key is odd-Y. */
function tweakShare(s: Share, t: bigint, oddY: boolean): Share {
	let xi = Fn.add(Fn.fromBytes(s.signingShare), t);
	if (oddY) xi = Fn.neg(xi);
	return { ...s, signingShare: Fn.toBytes(xi) };
}

/** Tweak the public package so its group key is the deposit key (and verifying shares
 *  match), with the BIP340 even-Y normalization. */
function tweakPub(pub: PublicPackage, t: bigint, oddY: boolean): PublicPackage {
	const tG = Pt.BASE.multiply(t);
	const adj = (p: ReturnType<typeof Pt.fromHex>) => (oddY ? p.negate() : p);
	const commitments = pub.commitments.map((c, i) => {
		const base = i === 0 ? Pt.fromHex(hex(c)).add(tG) : Pt.fromHex(hex(c));
		return adj(base).toBytes(true);
	});
	const verifyingShares = Object.fromEntries(Object.entries(pub.verifyingShares).map(([k, v]) => [k, adj(Pt.fromHex(hex(v)).add(tG)).toBytes(true)]));
	return { ...pub, commitments, verifyingShares };
}

/**
 * Threshold-sign a spend of a user's deposit UTXO. The quorum signs for the
 * tweaked deposit key without anyone reconstructing it; the result is a BIP340
 * signature valid against `depositOutputKey(fund, user)` — i.e. a real spend
 * Bitcoin accepts.
 */
export function signDepositSpend(fundKey: FundKey, userPubHex: string, quorumShares: Record<string, Share>, sighash: Uint8Array): Uint8Array {
	const t = depositTweak(fundKey.groupPubKey, userPubHex);
	const Q = Pt.fromHex(hex(fundKey.groupPubKey));
	const oddY = Q.add(Pt.BASE.multiply(t)).toBytes(true)[0] === 0x03;
	const tweakedPub = tweakPub(fundKey.pub, t, oddY);
	const tweakedShares: Record<string, Share> = {};
	for (const [k, s] of Object.entries(quorumShares)) tweakedShares[k] = tweakShare(s, t, oddY);
	return thresholdSign(sighash, tweakedPub, tweakedShares);
}
