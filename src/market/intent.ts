/**
 * Peer-to-peer bull/bear — the simplest matched directional bet.
 *
 *   1. A peer broadcasts a NON-BINDING signed OFFER over the gossip mesh: just a
 *      side (long/short), an amount, a leverage, and when it settles. Nothing is
 *      escrowed while it rests — it's a signal.
 *   2. A taker who wants the opposite side authors ONE ledger write carrying the
 *      maker's signed offer. The fold verifies the signature, checks BOTH peers can
 *      cover the stake right now (a maker who ghosted just fails), escrows both, and
 *      opens a bilateral CONTRACT at the current oracle mark (= the entry price).
 *   3. At/after the settle height, anyone settles it: directional PnL at the oracle
 *      price, CAPPED at the stake. Long gains what short loses; the loser can never
 *      owe more than it staked.
 *
 * No pool, no shares, no payoff bands. The protocol is never a counterparty, so it
 * can never be drained. "Leverage" just scales the move and tightens the cap: at
 * leverage L, a 1/L price move against you wipes your stake (and hands the whole pot
 * to the other side). Fully collateralized, zero-sum, bounded.
 *
 * Pure + deterministic (BigInt sats). Operates on the existing BridgeState so
 * conservation reuses the bridge's 1:1 accounting. Heights are the anchor clock.
 */

import { canonicalBytes, fromHex, toHex } from "../det/canonical.ts";
import { sign, verify } from "../det/ed25519.ts";
import type { BridgeState } from "../custody/bridge.ts";
import { gbtcOf, addGbtc } from "../custody/bridge.ts";

export type Side = "long" | "short";

/** The liquidity backstop's identity as a contract counterparty. Not a real pubkey (those are
 *  64 hex chars), so it can never collide with a holder. A contract side equal to POT is funded
 *  from / settled to `bridge.pot` (the idle-decay pool), never a `gbtc` balance. */
export const POT = "POT";

/** Leverage bounds an offer may specify. Higher = tighter cap (wiped by a smaller move).
 *  1× is a pointless fully-collateralized coin flip, so the floor is 2×. */
export const MIN_OFFER_LEVERAGE = 2n;
export const MAX_OFFER_LEVERAGE = 100n;

/** Maximum contract lifetime in anchors (the time-lock). A matched position auto-settles at the
 *  mark once it's this old — either side may still close EARLY, but nothing outlives the cap, so
 *  the open-contract set can't accumulate stuck positions. Consensus-critical: every node must
 *  use the same value. ~30 days at a 60s/anchor target. */
export const CONTRACT_MAX_LIFE = 43_200;

/** The signed part of an offer (everything except the signature). Canonical-JSON
 *  encoded and signed by the maker — a self-authenticating signal a taker can redeem
 *  on-chain without the maker being online. */
export interface OfferCore {
	/** Maker pubkey (hex). The signature is by this key. */
	maker: string;
	/** The side the MAKER takes; the taker gets the opposite. */
	makerSide: Side;
	/** Total stake (decimal sats) the maker offers — fillable in parts by many takers. */
	size: string;
	/** Leverage (decimal int ≥ 1). Scales the price move; a 1/leverage move caps the bet. */
	leverage: string;
	/** Anchor height after which the offer can no longer be matched (a soft TTL). */
	expiryHeight: number;
	/** Unique per offer — the redemption key (tracks cumulative fills ≤ size). */
	nonce: string;
}

export interface Offer extends OfferCore {
	/** Ed25519 signature (hex) by `maker` over canonicalBytes(OfferCore). */
	sig: string;
}

/** A live, escrowed bilateral bet. Pot = 2·stake; closing splits it directionally at the
 *  current mark. Perpetual — either side may close it any time (no expiry). */
export interface Contract {
	id: string; // the match write's id
	long: string; // pubkey holding the long side
	short: string; // pubkey holding the short side
	stake: bigint; // each side staked this; pot = 2·stake
	entry: bigint; // the oracle mark when matched
	leverage: bigint;
	nonce: string; // the originating offer (audit)
	expiryHeight: number; // auto-settles at the mark once the anchor clock reaches this (time-lock)
}

/** The matched-market state that lives alongside the bridge in the View. */
export interface MarketBook {
	/** Open contracts by id. */
	contracts: Map<string, Contract>;
	/** Per offer nonce: cumulative stake matched (enforces Σ fills ≤ size) + the offer's expiry
	 *  height, so the entry can be RETIRED once the offer can no longer be matched (bounds the map). */
	offerFills: Map<string, { filled: bigint; expiryHeight: number }>;
}

export function emptyBook(): MarketBook {
	return { contracts: new Map(), offerFills: new Map() };
}

/** gBTC escrowed across all open contracts (both sides) — the conservation bucket. */
export function escrowedInContracts(book: MarketBook): bigint {
	let t = 0n;
	for (const c of book.contracts.values()) t += c.stake * 2n;
	return t;
}

/** Retire fill-tracking for offers past their expiry. applyMatch already rejects any match on
 *  an expired offer, so a passed-expiry entry can never change again — dropping it bounds
 *  offerFills to live offers instead of every nonce ever matched. */
export function pruneExpiredOffers(book: MarketBook, nowHeight: number): void {
	for (const [nonce, f] of book.offerFills) if (nowHeight > f.expiryHeight) book.offerFills.delete(nonce);
}

// ── parsing / validation ─────────────────────────────────────────

function parseSats(s: unknown): bigint | null {
	if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
	try {
		const n = BigInt(s);
		return n > 0n ? n : null;
	} catch {
		return null;
	}
}

function isHex(s: unknown, bytes: number): boolean {
	return typeof s === "string" && s.length === bytes * 2 && /^[0-9a-f]+$/i.test(s);
}

// ── offer signing / verification ─────────────────────────────────

/** The exact bytes a maker signs (and a verifier re-derives). Sig is excluded. */
export function offerDigest(core: OfferCore): Uint8Array {
	return canonicalBytes({
		maker: core.maker,
		makerSide: core.makerSide,
		size: core.size,
		leverage: core.leverage,
		expiryHeight: core.expiryHeight,
		nonce: core.nonce,
	});
}

/** Attach a maker signature to an offer core. */
export function signOffer(core: OfferCore, makerPriv: Uint8Array): Offer {
	return { ...core, sig: toHex(sign(makerPriv, offerDigest(core))) };
}

/** Validate an offer's shape AND its maker signature. Never throws. */
export function verifyOffer(o: Offer): boolean {
	if (!o || typeof o !== "object") return false;
	if (!isHex(o.maker, 32)) return false;
	if (o.makerSide !== "long" && o.makerSide !== "short") return false;
	if (parseSats(o.size) === null) return false;
	const lev = parseSats(o.leverage);
	if (lev === null || lev < MIN_OFFER_LEVERAGE || lev > MAX_OFFER_LEVERAGE) return false; // 2 ≤ leverage ≤ MAX
	if (!Number.isInteger(o.expiryHeight)) return false;
	if (typeof o.nonce !== "string" || o.nonce.length === 0) return false;
	if (!isHex(o.sig, 64)) return false;
	try {
		return verify(fromHex(o.maker), offerDigest(o), fromHex(o.sig));
	} catch {
		return false;
	}
}

// ── payoff ───────────────────────────────────────────────────────

/**
 * The long side's share of the 2·stake pot at settlement `price`: directional PnL
 * `stake · leverage · (price − entry) / entry`, CAPPED to ±stake, added to its own
 * stake. So the result is in [0, 2·stake]; the short side gets the remainder. Exactly
 * zero-sum, and neither side can lose more than it staked.
 */
export function longPayout(stake: bigint, entry: bigint, leverage: bigint, price: bigint): bigint {
	let pnl = (stake * leverage * (price - entry)) / entry; // signed; bigint truncates toward zero
	if (pnl > stake) pnl = stake;
	else if (pnl < -stake) pnl = -stake;
	return stake + pnl; // long's take of the 2·stake pot, in [0, 2·stake]
}

// ── match / settle (operate on the bridge + book) ────────────────

/**
 * A taker redeems part of a maker's signed offer at the current oracle `mark` (the
 * entry price). Returns the opened contract, or null if rejected (bad/expired offer,
 * self-match, exhausted, no mark, or either side can't cover — the ghost case). The
 * match write's id becomes the contract id. `fill` is clamped to the offer's
 * remaining size (partial fill); both sides escrow `take`.
 */
export function applyMatch(bridge: BridgeState, book: MarketBook, taker: string, writeId: string, offer: Offer, fill: bigint, nowHeight: number, mark: bigint): Contract | null {
	if (mark <= 0n) return null; // no oracle price yet → no entry
	if (!verifyOffer(offer)) return null;
	if (nowHeight > offer.expiryHeight) return null; // offer no longer takeable (soft TTL)
	if (offer.maker === taker) return null; // self-match (wash) guard
	if (book.contracts.has(writeId)) return null; // id reuse
	if (fill <= 0n) return null;

	const size = parseSats(offer.size)!;
	const already = book.offerFills.get(offer.nonce)?.filled ?? 0n;
	const remaining = size - already;
	if (remaining <= 0n) return null; // offer fully consumed
	const take = fill <= remaining ? fill : remaining; // partial fill

	if (gbtcOf(bridge, offer.maker) < take || gbtcOf(bridge, taker) < take) return null; // ghost → no-op

	addGbtc(bridge, offer.maker, -take); // escrow both stakes → the contract
	addGbtc(bridge, taker, -take);
	book.offerFills.set(offer.nonce, { filled: already + take, expiryHeight: offer.expiryHeight });

	const long = offer.makerSide === "long" ? offer.maker : taker;
	const short = offer.makerSide === "long" ? taker : offer.maker;
	const c: Contract = { id: writeId, long, short, stake: take, entry: mark, leverage: parseSats(offer.leverage)!, nonce: offer.nonce, expiryHeight: nowHeight + CONTRACT_MAX_LIFE };
	book.contracts.set(writeId, c);
	return c;
}

/**
 * Close (settle) a contract at the oracle `price`: split the 2·stake pot directionally
 * and credit each side's free gBTC. Either side (in fact anyone) may close it EARLY at the
 * current mark; the loser can't escape the mark by stalling. A position that's never closed
 * early auto-settles at its time-lock (see settleExpired).
 */
export function applySettle(bridge: BridgeState, book: MarketBook, contractId: string, price: bigint, height?: number): boolean {
	const c = book.contracts.get(contractId);
	if (!c) return false;
	const pot = c.stake * 2n;
	const longPay = longPayout(c.stake, c.entry, c.leverage, price);
	const shortPay = pot - longPay; // exact remainder → zero-sum
	creditParty(bridge, c.long, longPay, height); // payout = a fresh credit → restarts the idle clock
	creditParty(bridge, c.short, shortPay, height);
	book.contracts.delete(contractId);
	return true;
}

/** Pay a contract side. The backstop POT is paid into `bridge.pot` (no holder balance, no idle
 *  clock — the pot isn't an idle squatter); everyone else gets a normal gBTC credit. */
function creditParty(bridge: BridgeState, who: string, amount: bigint, height?: number): void {
	if (who === POT) bridge.pot += amount;
	else addGbtc(bridge, who, amount, height);
}

/**
 * A taker opens a position directly against the liquidity BACKSTOP — no peer maker needed. The pot
 * takes the OPPOSITE side at the current oracle `mark`, staking matching gBTC from `bridge.pot`.
 * `available` is the deterministic backstop budget (see BridgeState.potEscrowTaken): the stake is
 * clamped to it, so the free pot provably never goes negative even under a loss storm. `fill` is
 * also clamped to what the taker can cover. Returns the opened contract, or null if rejected (no
 * mark, bad leverage, id reuse, or no budget/coverage). The pot's PnL flows back into `bridge.pot`
 * at settle — winning trades drain idle capital out to traders; losing trades refill it.
 */
export function applyMatchPot(bridge: BridgeState, book: MarketBook, taker: string, writeId: string, takerSide: Side, fill: bigint, leverage: bigint, nowHeight: number, mark: bigint, available: bigint): Contract | null {
	if (mark <= 0n) return null; // no market price yet → no entry
	if (taker === POT) return null; // the pot can't take its own side
	if (book.contracts.has(writeId)) return null; // id reuse
	if (fill <= 0n) return null;
	if (leverage < MIN_OFFER_LEVERAGE || leverage > MAX_OFFER_LEVERAGE) return null;

	const budget = available > 0n ? available : 0n;
	let take = fill;
	const takerFree = gbtcOf(bridge, taker);
	if (take > takerFree) take = takerFree; // taker can't cover → partial
	if (take > budget) take = budget; // pot's finalized budget → partial
	if (take <= 0n) return null; // taker broke or pot exhausted → no-op

	addGbtc(bridge, taker, -take); // taker escrows its stake
	bridge.pot -= take; // pot escrows the matching counter-stake (≥ 0 by the budget invariant)
	bridge.potEscrowTaken += take; // committed counter the budget is measured against
	const long = takerSide === "long" ? taker : POT;
	const short = takerSide === "long" ? POT : taker;
	const c: Contract = { id: writeId, long, short, stake: take, entry: mark, leverage, nonce: writeId, expiryHeight: nowHeight + CONTRACT_MAX_LIFE };
	book.contracts.set(writeId, c);
	return c;
}

/**
 * Auto-unwind every contract whose time-lock has elapsed (expiryHeight ≤ nowHeight): settle at
 * its OWN ENTRY price, i.e. return each side its stake (no PnL). A perp can't outlive its cap,
 * so the open-contract set is bounded by throughput × CONTRACT_MAX_LIFE.
 *
 * Why entry and not the mark: this sweep runs at the fold's `nowHeight`, which a checkpoint-
 * resumed node reaches from a different base than a full node — and the oracle mark is
 * time-varying, so settling at the mark would settle the SAME contract at DIFFERENT prices
 * depending on where the node last checkpointed → divergent appRoot → fork. Entry is stored in
 * the contract, so it's base-independent and every node agrees. To realize PnL you close EARLY
 * via `contract.settle` (settle-at-mark, deterministic via the write's fold position); a
 * position nobody closes by the cap just unwinds.
 */
export function settleExpired(bridge: BridgeState, book: MarketBook, nowHeight: number): void {
	const due: string[] = [];
	for (const [id, c] of book.contracts) if (nowHeight >= c.expiryHeight) due.push(id);
	for (const id of due) {
		const c = book.contracts.get(id)!;
		// Unwind at entry → each gets its stake back. Credit at the contract's EXPIRY height (not
		// the fold's nowHeight) so the returned stake's idle clock resets to the same height on
		// every node, regardless of when each node's fold first crossed the expiry (else fork).
		applySettle(bridge, book, id, c.entry, c.expiryHeight);
	}
}
