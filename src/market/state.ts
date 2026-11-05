/**
 * The application state an anchor commits to (its `appRoot`), and its deterministic encoding.
 *
 * Gavl's app layer is the ephemeral BTC↔LTC order board: listed offers and the matches taken
 * against them. Coins never touch this chain (swaps settle on Bitcoin and Litecoin via HTLCs),
 * so there is no balance ledger — only who offered what, who took it, the swap terms both sides
 * build their HTLCs from, and the coordination hints (proofs of funds, lock outpoints). The fold
 * (market/fold.ts) builds it from certified writes; everything in it expires (offers at their
 * TTL, matches past the longest refund window), so the state stays small.
 *
 *   serializeView(view) -> CanonState   (plain JSON: Maps → id-sorted arrays, bigint → decimal)
 *   viewRoot(view)      -> sha256Hex(canonicalize(CanonState))
 *   deserializeView(s)  -> View          (exact inverse — loads a snapshot back into RAM)
 *
 * CONSENSUS-CRITICAL: every node must compute the SAME root for the SAME logical state,
 * regardless of Map insertion order.
 */

import { sha256Hex, canonicalize } from "../det/canonical.ts";
import type { Chain, FundsProof, Leg } from "./ops.ts";

/** A listed offer: the maker gives `give` for `want` (price implied), in fills of ≥ minFill. */
export interface Offer {
	/** Id of the `offer.post` write. */
	id: string;
	maker: string;
	give: Leg;
	want: Leg;
	minFill: bigint;
	/** Give-units still takeable (give.amount minus every open match's reserved fill). */
	remaining: bigint;
	/** Certifying height of the post. */
	postedAt: number;
	/** First height at which the offer is gone (postedAt + expiresIn). */
	expiresAt: number;
}

export type MatchStatus = "awaitingProofs" | "escrow" | "cancelled";

export interface LockHint {
	txid: string;
	vout: number;
	/** Certifying height of the `swap.locked` write. */
	at: number;
}

/**
 * A take against an offer, with the full swap terms. The TAKER is the initiator: it holds the
 * secret (hash = sha256(secret)), locks `takerAmount` on `takerChain` first, refundable after
 * `takerRefundBlocks`; the MAKER locks `makerAmount` on `makerChain` second, refundable after
 * `makerRefundBlocks`. Refund windows are in blocks of the chain each lock sits on.
 */
export interface Match {
	/** Id of the `offer.take` write. */
	id: string;
	offerId: string;
	maker: string;
	taker: string;
	/** The taker's write seq of the take — with offerId + taker, the taker's pre-post swap id. */
	takeSeq: number;
	makerChain: Chain;
	makerAmount: bigint;
	makerRefundBlocks: number;
	takerChain: Chain;
	takerAmount: bigint;
	takerRefundBlocks: number;
	hash: string;
	takerKey: string;
	/** Set by the maker's proof. */
	makerKey: string | null;
	status: MatchStatus;
	takenAt: number;
	/** Last height at which a `swap.proof` is accepted. */
	proofDeadline: number;
	/** First height at which the record is dropped. */
	pruneAt: number;
	makerProof: FundsProof | null;
	takerProof: FundsProof | null;
	makerLock: LockHint | null;
	takerLock: LockHint | null;
	cancelled: { at: number; reason: "noProof" | "abort" } | null;
}

/** The folded application state. */
export interface View {
	offers: Map<string, Offer>;
	matches: Map<string, Match>;
}

// ── canonical (plain-JSON) shape ─────────────────────────────────

export interface CanonLeg {
	chain: Chain;
	amount: string;
}

export interface CanonOffer {
	id: string;
	maker: string;
	give: CanonLeg;
	want: CanonLeg;
	minFill: string;
	remaining: string;
	postedAt: number;
	expiresAt: number;
}

export interface CanonMatch extends Omit<Match, "makerAmount" | "takerAmount"> {
	makerAmount: string;
	takerAmount: string;
}

/** Plain-JSON (canonical) form of the View, as stored in checkpoints. Arrays sorted by id. */
export interface CanonState {
	offers: CanonOffer[];
	matches: CanonMatch[];
}

export function emptyView(): View {
	return { offers: new Map(), matches: new Map() };
}

// ── serialize ────────────────────────────────────────────────────

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const canonLeg = (l: Leg): CanonLeg => ({ chain: l.chain, amount: l.amount.toString() });

export function canonOffer(o: Offer): CanonOffer {
	return { id: o.id, maker: o.maker, give: canonLeg(o.give), want: canonLeg(o.want), minFill: o.minFill.toString(), remaining: o.remaining.toString(), postedAt: o.postedAt, expiresAt: o.expiresAt };
}

function copyProof(p: FundsProof | null): FundsProof | null {
	return p && { chain: p.chain, net: p.net, pubkey: p.pubkey, utxos: p.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })), sig: p.sig };
}

function copyLock(l: LockHint | null): LockHint | null {
	return l && { txid: l.txid, vout: l.vout, at: l.at };
}

/** Every Match field but the two amounts, copied field by field — so no stray key from a
 *  snapshot survives into the View, and copies never alias. */
function matchBody(m: Match | CanonMatch): Omit<Match, "makerAmount" | "takerAmount"> {
	return {
		id: m.id,
		offerId: m.offerId,
		maker: m.maker,
		taker: m.taker,
		takeSeq: m.takeSeq,
		makerChain: m.makerChain,
		makerRefundBlocks: m.makerRefundBlocks,
		takerChain: m.takerChain,
		takerRefundBlocks: m.takerRefundBlocks,
		hash: m.hash,
		takerKey: m.takerKey,
		makerKey: m.makerKey,
		status: m.status,
		takenAt: m.takenAt,
		proofDeadline: m.proofDeadline,
		pruneAt: m.pruneAt,
		makerProof: copyProof(m.makerProof),
		takerProof: copyProof(m.takerProof),
		makerLock: copyLock(m.makerLock),
		takerLock: copyLock(m.takerLock),
		cancelled: m.cancelled && { at: m.cancelled.at, reason: m.cancelled.reason },
	};
}

export function canonMatch(m: Match): CanonMatch {
	return { ...matchBody(m), makerAmount: m.makerAmount.toString(), takerAmount: m.takerAmount.toString() };
}

export function serializeView(view: View): CanonState {
	return {
		offers: [...view.offers.values()].map(canonOffer).sort(byId),
		matches: [...view.matches.values()].map(canonMatch).sort(byId),
	};
}

/** The application-state commitment: a single hash over the whole View. */
export function viewRoot(view: View): string {
	return sha256Hex(canonicalize(serializeView(view)));
}

// ── deserialize (exact inverse) ──────────────────────────────────

const leg = (l: CanonLeg): Leg => ({ chain: l.chain, amount: BigInt(l.amount) });

/** Exact inverse of serializeView. Rejects anything that doesn't round-trip to the identical
 *  canonical bytes (unknown fields, unsorted/duplicate ids, non-canonical numbers), so a peer
 *  can't smuggle junk into a checkpoint. */
export function deserializeView(s: CanonState): View {
	const view = emptyView();
	try {
		for (const o of s.offers) {
			view.offers.set(o.id, { id: o.id, maker: o.maker, give: leg(o.give), want: leg(o.want), minFill: BigInt(o.minFill), remaining: BigInt(o.remaining), postedAt: o.postedAt, expiresAt: o.expiresAt });
		}
		for (const m of s.matches) view.matches.set(m.id, { ...matchBody(m), makerAmount: BigInt(m.makerAmount), takerAmount: BigInt(m.takerAmount) });
		if (Object.keys(s).length !== 2 || canonicalize(serializeView(view)) !== canonicalize(s)) throw new Error("not canonical");
	} catch {
		throw new Error("state: not a canonical app state");
	}
	return view;
}

/** Deep copy (a resumed fold mutates its own copy, never the cached/snapshot base). */
export function cloneView(v: View): View {
	const out = emptyView();
	for (const [id, o] of v.offers) out.offers.set(id, { ...o, give: { ...o.give }, want: { ...o.want } });
	for (const [id, m] of v.matches) out.matches.set(id, { ...matchBody(m), makerAmount: m.makerAmount, takerAmount: m.takerAmount });
	return out;
}
