/**
 * The order-board op vocabulary and its strict payload parser.
 *
 * Every op rides in an Ed25519-signed write, so the actor IS `write.writer`. Amounts are
 * base units (sats / litoshis) as canonical decimal strings (BigInt-parsed, JSON-safe). Ids
 * are write ids (64 lowercase hex): offerId = id of the `offer.post` write, matchId = id of the
 * `offer.take` write. Keys and hashes are 64 lowercase hex.
 *
 *   offer.post   { give: {chain, amount}, want: {chain, amount}, minFill, expiresIn }
 *   offer.cancel { offerId }
 *   offer.take   { offerId, fill, hash, takerKey }
 *   swap.proof   { matchId, makerKey?, proof }
 *   swap.locked  { matchId, txid, vout }
 *   swap.abort   { matchId }
 *
 * `parseOp` checks SHAPE only (exact key sets, types, encodings, ranges that need no state);
 * the fold (market/fold.ts) checks everything that depends on the View. A payload that fails
 * either is silently ignored by the fold — the write still exists, it just does nothing.
 * CONSENSUS-CRITICAL: every node must accept exactly the same payloads.
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import type { Chain } from "../chains/esplora.ts";
import { fundsProofShapeError, MAX_MONEY } from "../swap/proof.ts";
import type { FundsProof } from "../swap/proof.ts";

export type { Chain } from "../chains/esplora.ts";
export type { FundsProof } from "../swap/proof.ts";

/** Default offer lifetime: 24h of anchors at the 60s Gavl target. */
export const DEFAULT_OFFER_TTL = 1440;
/** Longest an offer may stay listed: 48h of anchors. Keeps the board ephemeral and its state bounded. */
export const MAX_OFFER_TTL = 2880;

export interface Leg {
	chain: Chain;
	amount: bigint;
}

export type Op =
	| { kind: "offer.post"; give: Leg; want: Leg; minFill: bigint; expiresIn: number }
	| { kind: "offer.cancel"; offerId: string }
	| { kind: "offer.take"; offerId: string; fill: bigint; hash: string; takerKey: string }
	| { kind: "swap.proof"; matchId: string; makerKey: string | null; proof: FundsProof }
	| { kind: "swap.locked"; matchId: string; txid: string; vout: number }
	| { kind: "swap.abort"; matchId: string };

export type OpKind = Op["kind"];

// ── primitive checks ─────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^[1-9][0-9]{0,18}$/;

type Obj = Record<string, unknown>;

/** A plain (JSON) object whose own keys are exactly `required` plus any of `optional`. */
function exact(v: unknown, required: readonly string[], optional: readonly string[] = []): v is Obj {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	if (proto !== Object.prototype && proto !== null) return false;
	const keys = Object.keys(v);
	for (const k of required) if (!Object.hasOwn(v, k)) return false;
	for (const k of keys) if (!required.includes(k) && !optional.includes(k)) return false;
	return true;
}

export function isChain(v: unknown): v is Chain {
	return v === "bitcoin" || v === "litecoin";
}

export function isHex64(v: unknown): v is string {
	return typeof v === "string" && HEX64.test(v);
}

/** A 64-hex BIP340 x-only key that lifts to a curve point (an HTLC can actually be built on it). */
export function isXOnlyKey(v: unknown): v is string {
	if (!isHex64(v)) return false;
	try {
		schnorr.utils.lift_x(BigInt("0x" + v));
		return true;
	} catch {
		return false;
	}
}

/** Canonical positive decimal ≤ `max`, or null. */
export function parseAmount(v: unknown, max: bigint): bigint | null {
	if (typeof v !== "string" || !AMOUNT.test(v)) return null;
	const n = BigInt(v);
	return n <= max ? n : null;
}

function parseLeg(v: unknown): Leg | null {
	if (!exact(v, ["chain", "amount"]) || !isChain(v.chain)) return null;
	const amount = parseAmount(v.amount, MAX_MONEY[v.chain]);
	return amount === null ? null : { chain: v.chain, amount };
}

function isVout(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

// ── parser ───────────────────────────────────────────────────────

/** Parse a write payload into an op, or null if it isn't a well-formed order-board op. */
export function parseOp(payload: unknown): Op | null {
	if (payload === null || typeof payload !== "object" || typeof (payload as Obj).kind !== "string") return null;
	const p = payload as Obj;
	switch (p.kind) {
		case "offer.post": {
			if (!exact(p, ["kind", "give", "want", "minFill", "expiresIn"])) return null;
			const give = parseLeg(p.give);
			const want = parseLeg(p.want);
			if (!give || !want || give.chain === want.chain) return null;
			const minFill = parseAmount(p.minFill, give.amount);
			if (minFill === null) return null;
			const ttl = p.expiresIn;
			if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_OFFER_TTL) return null;
			return { kind: "offer.post", give, want, minFill, expiresIn: ttl };
		}
		case "offer.cancel":
			if (!exact(p, ["kind", "offerId"]) || !isHex64(p.offerId)) return null;
			return { kind: "offer.cancel", offerId: p.offerId };
		case "offer.take": {
			if (!exact(p, ["kind", "offerId", "fill", "hash", "takerKey"])) return null;
			if (!isHex64(p.offerId) || !isHex64(p.hash) || !isXOnlyKey(p.takerKey)) return null;
			const fill = parseAmount(p.fill, MAX_MONEY.litecoin); // the offer bounds it further (≤ remaining)
			if (fill === null) return null;
			return { kind: "offer.take", offerId: p.offerId, fill, hash: p.hash, takerKey: p.takerKey };
		}
		case "swap.proof": {
			if (!exact(p, ["kind", "matchId", "proof"], ["makerKey"])) return null;
			if (!isHex64(p.matchId) || fundsProofShapeError(p.proof) !== null) return null;
			if (Object.hasOwn(p, "makerKey") && !isXOnlyKey(p.makerKey)) return null;
			return { kind: "swap.proof", matchId: p.matchId, makerKey: (p.makerKey as string | undefined) ?? null, proof: p.proof as FundsProof };
		}
		case "swap.locked":
			if (!exact(p, ["kind", "matchId", "txid", "vout"]) || !isHex64(p.matchId) || !isHex64(p.txid) || !isVout(p.vout)) return null;
			return { kind: "swap.locked", matchId: p.matchId, txid: p.txid, vout: p.vout };
		case "swap.abort":
			if (!exact(p, ["kind", "matchId"]) || !isHex64(p.matchId)) return null;
			return { kind: "swap.abort", matchId: p.matchId };
		default:
			return null;
	}
}

/** The JSON payload a write carries for `op` (bigints → decimal strings; makerKey omitted when null). */
export function opPayload(op: Op): Record<string, unknown> {
	switch (op.kind) {
		case "offer.post":
			return {
				kind: op.kind,
				give: { chain: op.give.chain, amount: op.give.amount.toString() },
				want: { chain: op.want.chain, amount: op.want.amount.toString() },
				minFill: op.minFill.toString(),
				expiresIn: op.expiresIn,
			};
		case "offer.take":
			return { kind: op.kind, offerId: op.offerId, fill: op.fill.toString(), hash: op.hash, takerKey: op.takerKey };
		case "swap.proof":
			return op.makerKey === null ? { kind: op.kind, matchId: op.matchId, proof: op.proof } : { kind: op.kind, matchId: op.matchId, makerKey: op.makerKey, proof: op.proof };
		default:
			return { ...op };
	}
}
