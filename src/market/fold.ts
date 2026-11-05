/**
 * The order-board fold: certified writes + the anchor clock → View.
 *
 * A PURE function of (the writes an anchor certifies, their certifying heights, the anchor's
 * height). Nothing reads a wall clock or a foreign chain: proofs of funds are only shape-checked
 * here (the counterparty's daemon verifies them on Bitcoin/Litecoin), and lock hints are recorded
 * as posted.
 *
 * Time is the Gavl anchor height. Writes fold in the PoST-bound order (consensus/order.ts); a
 * write certified at height h first moves the state to h (`advance`), then applies. `advance`
 * runs every height-timed transition — proof deadlines, offer expiry, match pruning — and is
 * path-independent: advance(advance(s, a), b) = advance(s, b) for a ≤ b, and every timed effect
 * is stamped with the deadline it fired at, never the height it was observed at. So folding
 * all history in one pass, resuming from a checkpoint, or folding in any number of splits all
 * reach byte-identical state (test/orders-determinism.test.ts).
 *
 * Height conventions:
 *   offer   live while h < expiresAt                      (expiresAt = postedAt + expiresIn)
 *   proofs  accepted while h ≤ proofDeadline              (proofDeadline = takenAt + PROOF_WINDOW)
 *   match   dropped once h ≥ pruneAt                      (pruneAt = takenAt + matchLifetime(takerChain))
 *
 * CONSENSUS-CRITICAL: every node must reach the same View from the same certified writes.
 */

import type { Write } from "../chain/writer.ts";
import type { AnchorChain } from "../consensus/chain.ts";
import { orderingFor } from "../consensus/order.ts";
import { defaultRefundBlocks } from "../swap/htlc.ts";
import { dustThreshold, NETWORKS } from "../swap/networks.ts";
import { parseOp } from "./ops.ts";
import type { Chain, Op } from "./ops.ts";
import { cloneView, emptyView } from "./state.ts";
import type { Match, Offer, View } from "./state.ts";

// ── protocol constants (consensus-critical) ──────────────────────

/** Gavl's anchor target spacing, seconds (the difficulty target and the idle heartbeat). */
export const ANCHOR_SECONDS = 60;
/** Anchors after the take during which BOTH sides must post `swap.proof` (~10 min). */
export const PROOF_WINDOW = 10;
/** Anchors the taker gets to lock once proofs are in (~30 min). The taker's refund clock can't
 *  start before its lock confirms, so this widens the record's lifetime. */
export const TAKER_LOCK_WINDOW = 30;
/**
 * Slack added on top of the taker's refund window before a match record is dropped: 720 anchors
 * (12h nominal, half the 24h initiator window). Covers the two ways anchor-time and chain-time
 * drift apart — chain blocks arriving slower than target (hashrate dips stretch a 144-block BTC
 * window past 24h) and Gavl anchors arriving faster than 60s — plus confirmation lag on the lock.
 * Over-keeping a record costs a few hundred bytes; dropping it early strands a refund lookup.
 */
export const PRUNE_MARGIN = 720;

/** A chain's refund window in Gavl anchors, rounded up — assumes the chain mines at its target
 *  spacing and Gavl at ANCHOR_SECONDS (BTC 144 × 600s = LTC 576 × 150s = 24h = 1440 anchors). */
export function refundAnchors(chain: Chain, role: "initiator" | "counterparty"): number {
	return Math.ceil((defaultRefundBlocks(chain, role) * NETWORKS[chain].mainnet.blockSeconds) / ANCHOR_SECONDS);
}

/** Anchors a match record lives after its take: until the taker's (longest) refund window has
 *  surely elapsed. The taker locks within PROOF_WINDOW + TAKER_LOCK_WINDOW, and the maker's lock
 *  (≤ 1h after the taker's, 12h window) always closes before the taker's 24h window. Default:
 *  10 + 30 + 1440 + 720 = 2200 anchors ≈ 36.7h. */
export function matchLifetime(takerChain: Chain): number {
	return PROOF_WINDOW + TAKER_LOCK_WINDOW + refundAnchors(takerChain, "initiator") + PRUNE_MARGIN;
}

/** OP_1 <32 bytes>: the shape of every HTLC output (P2TR). Only the length matters for dust. */
const P2TR_SCRIPT = new Uint8Array([0x51, 0x20, ...new Uint8Array(32)]);

/** Smallest HTLC output the chain relays (P2TR dust: BTC 330 sats, LTC 3300 litoshis). Policy, not
 *  net-specific, so mainnet's figure applies everywhere. */
export const DUST: Readonly<Record<Chain, bigint>> = Object.freeze({
	bitcoin: dustThreshold(NETWORKS.bitcoin.mainnet, P2TR_SCRIPT),
	litecoin: dustThreshold(NETWORKS.litecoin.mainnet, P2TR_SCRIPT),
});

/** The want-leg owed for a fill of `fill` give-units: floor(fill × want / give). */
export function proRata(offer: Pick<Offer, "give" | "want">, fill: bigint): bigint {
	return (fill * offer.want.amount) / offer.give.amount;
}

// ── transitions ──────────────────────────────────────────────────

/** The parts of a write an op needs: its id (offer/match ids), author, and seq. */
export type WriteRef = Pick<Write, "id" | "writer" | "seq">;

function restoreCapacity(view: View, m: Match): void {
	const offer = view.offers.get(m.offerId);
	if (offer) offer.remaining += m.makerAmount;
}

/**
 * Move the state to height `h`: cancel matches whose proof deadline passed (restoring the
 * offer's capacity), drop matches past pruneAt, drop expired offers. Idempotent and composable
 * (see the module doc); call with non-decreasing heights.
 */
export function advance(view: View, h: number): void {
	for (const [id, m] of view.matches) {
		if (m.status === "awaitingProofs" && m.proofDeadline < h) {
			m.status = "cancelled";
			m.cancelled = { at: m.proofDeadline + 1, reason: "noProof" }; // the deadline, not the observing height → path-independent
			restoreCapacity(view, m);
		}
		if (m.pruneAt <= h) view.matches.delete(id);
	}
	for (const [id, o] of view.offers) if (o.expiresAt <= h) view.offers.delete(id);
}

/**
 * Apply one op authored by `w` at certifying height `h` (the view must already be advanced to
 * h). Returns null if applied, else why it was rejected — the fold ignores the reason (the write
 * just does nothing); the daemon surfaces it before paying a write's cooldown.
 */
export function applyOp(view: View, w: WriteRef, op: Op, h: number): string | null {
	switch (op.kind) {
		case "offer.post": {
			const { give, want, minFill } = op;
			if (give.amount < DUST[give.chain] || want.amount < DUST[want.chain]) return "an offer leg is below the dust floor";
			if (minFill < DUST[give.chain] || proRata(op, minFill) < DUST[want.chain]) return "minFill would allow a dust leg";
			if (view.offers.has(w.id)) return "duplicate offer id";
			view.offers.set(w.id, { id: w.id, maker: w.writer, give: { ...give }, want: { ...want }, minFill, remaining: give.amount, postedAt: h, expiresAt: h + op.expiresIn });
			return null;
		}
		case "offer.cancel": {
			const offer = view.offers.get(op.offerId);
			if (!offer) return "no such offer";
			if (offer.maker !== w.writer) return "only the maker may cancel an offer";
			view.offers.delete(op.offerId); // open matches keep their reserved fill
			return null;
		}
		case "offer.take": {
			const offer = view.offers.get(op.offerId);
			if (!offer) return "no such offer";
			if (offer.maker === w.writer) return "a maker cannot take its own offer";
			if (op.fill < offer.minFill) return "fill is below the offer's minimum";
			if (op.fill > offer.remaining) return "fill exceeds the offer's remaining capacity";
			const takerAmount = proRata(offer, op.fill);
			if (op.fill < DUST[offer.give.chain] || takerAmount < DUST[offer.want.chain]) return "fill makes a dust leg";
			if (view.matches.has(w.id)) return "duplicate match id";
			for (const m of view.matches.values()) if (m.hash === op.hash) return "hash already used by another match";
			offer.remaining -= op.fill;
			view.matches.set(w.id, {
				id: w.id,
				offerId: offer.id,
				maker: offer.maker,
				taker: w.writer,
				takeSeq: w.seq,
				makerChain: offer.give.chain,
				makerAmount: op.fill,
				makerRefundBlocks: defaultRefundBlocks(offer.give.chain, "counterparty"),
				takerChain: offer.want.chain,
				takerAmount,
				takerRefundBlocks: defaultRefundBlocks(offer.want.chain, "initiator"),
				hash: op.hash,
				takerKey: op.takerKey,
				makerKey: null,
				status: "awaitingProofs",
				takenAt: h,
				proofDeadline: h + PROOF_WINDOW,
				pruneAt: h + matchLifetime(offer.want.chain),
				makerProof: null,
				takerProof: null,
				makerLock: null,
				takerLock: null,
				cancelled: null,
			});
			return null;
		}
		case "swap.proof": {
			const m = view.matches.get(op.matchId);
			if (!m) return "no such match";
			if (m.status !== "awaitingProofs" || h > m.proofDeadline) return "match is not awaiting proofs";
			const p = op.proof;
			const proof = { chain: p.chain, net: p.net, pubkey: p.pubkey, utxos: p.utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })), sig: p.sig };
			if (w.writer === m.maker) {
				if (m.makerProof) return "maker already posted a proof";
				if (op.makerKey === null) return "the maker's proof must carry makerKey";
				if (op.makerKey === m.takerKey) return "makerKey equals takerKey";
				if (p.chain !== m.makerChain) return "proof is for the wrong chain";
				m.makerProof = proof;
				m.makerKey = op.makerKey;
			} else if (w.writer === m.taker) {
				if (m.takerProof) return "taker already posted a proof";
				if (op.makerKey !== null) return "only the maker's proof carries makerKey";
				if (p.chain !== m.takerChain) return "proof is for the wrong chain";
				m.takerProof = proof;
			} else return "not a party to the match";
			if (m.makerProof && m.takerProof) m.status = "escrow";
			return null;
		}
		case "swap.locked": {
			const m = view.matches.get(op.matchId);
			if (!m) return "no such match";
			if (m.status !== "escrow") return "match is not in escrow";
			const hint = { txid: op.txid, vout: op.vout, at: h };
			if (w.writer === m.maker) {
				if (m.makerLock) return "maker lock already recorded";
				m.makerLock = hint;
			} else if (w.writer === m.taker) {
				if (m.takerLock) return "taker lock already recorded";
				m.takerLock = hint;
			} else return "not a party to the match";
			return null;
		}
		case "swap.abort": {
			const m = view.matches.get(op.matchId);
			if (!m) return "no such match";
			if (w.writer !== m.maker) return "only the maker may abort";
			if (m.status === "cancelled") return "match already cancelled";
			if (m.makerLock) return "maker already locked";
			m.status = "cancelled";
			m.cancelled = { at: h, reason: "abort" };
			restoreCapacity(view, m);
			return null;
		}
	}
}

// ── folds ────────────────────────────────────────────────────────

export interface FoldOptions {
	/** Order WITHIN one certifying height (default: ts, writer, seq). The certified fold passes the
	 *  PoST-bound order. Across heights, writes always fold in height order. */
	order?: (a: Write, b: Write) => number;
	/** writeId → certifying height. A write missing from it folds at nowHeight. */
	bornAt?: Map<string, number>;
	/** Resume from this state (a checkpoint at or below every write's height); never mutated. */
	base?: View;
}

const byTs = (a: Write, b: Write): number => a.ts - b.ts || (a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0) || a.seq - b.seq;

/** Fold `writes` onto `base` (or the empty board), ending advanced to `nowHeight`. */
export function computeView(writes: Write[], nowHeight: number, opts: FoldOptions = {}): View {
	const view = opts.base ? cloneView(opts.base) : emptyView();
	const heightOf = (w: Write): number => Math.min(opts.bornAt?.get(w.id) ?? nowHeight, nowHeight);
	const order = opts.order ?? byTs;
	for (const w of [...writes].sort((a, b) => heightOf(a) - heightOf(b) || order(a, b))) {
		const h = heightOf(w);
		advance(view, h);
		const op = parseOp(w.payload);
		if (op) applyOp(view, w, op, h);
	}
	advance(view, nowHeight);
	return view;
}

/**
 * The state anchor `anchorId` commits to: exactly the writes its heads certify, in the
 * chain-induced order, each at its certifying height, advanced to the anchor's height. An
 * anchor's CHILD carries viewRoot of this as its appRoot (lag-by-parent). `base` resumes a
 * pruned node from its checkpoint (then `writes` must hold only what's above it). Unknown anchor
 * → the base (or empty) state unchanged.
 */
export function viewAtAnchor(writes: Write[], anchors: AnchorChain, anchorId: string, base?: View): View {
	const o = orderingFor(writes, anchors, anchors.get(anchorId) ?? null);
	if (o.nowHeight === null) return base ? cloneView(base) : emptyView();
	return computeView(o.included, o.nowHeight, { order: o.order, bornAt: o.bornAt, base });
}
