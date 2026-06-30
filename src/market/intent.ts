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

/** Global hard cap on simultaneously-open positions — the folded `book.contracts` can never exceed
 *  this. A full book rejects new matches (wait-in-line); the bid-to-evict path that lets a higher bid
 *  displace the lowest-bid position lands in a later step. Consensus-critical: every node must agree.
 *  Sized from the Phase 0 capacity benchmark — 1,000,000 × ~393 B ≈ 375 MB of committed state. */
export const MAX_OPEN_POSITIONS = 1_000_000;

/** Per-account hard cap on simultaneously-open positions (contract-sides held). Caps any one account's
 *  share of the global book so no single account can monopolize the slots — at full capacity at least
 *  MAX_OPEN_POSITIONS / MAX_POSITIONS_PER_ACCOUNT distinct accounts must be present. Consensus-critical. */
export const MAX_POSITIONS_PER_ACCOUNT = 1_000;

/** Basis-point denominator (10000 bps = 100%). */
export const BPS = 10_000n;
/** The protocol's default maker fee, in basis points of the stake. It's used in two consensus spots:
 *  (1) the pot charges it as a counterparty (a paid maker of last resort), and (2) it's the CAP on how
 *  much of a peer maker's spread the pot will SUBSIDISE on a peer match. Consensus-critical — every node
 *  must agree. The client also pre-fills makers' offers with it (editable). */
export const DEFAULT_SPREAD_BPS = 10n; // 0.10%
/** Protocol sanity cap on an offer's spread — keeps the fee ≤ stake so coverage can't overflow. The UI
 *  bounds far lower; this only stops absurd values from being signed into an offer. */
export const SPREAD_MAX_BPS = BPS; // 100%

/** The maker fee for a fill: `stake · spreadBps / 10000` (sats, truncated). */
export function feeOf(stake: bigint, spreadBps: bigint): bigint {
	return (stake * spreadBps) / BPS;
}

/** Parse a spread (basis points): a non-negative integer string ≤ SPREAD_MAX_BPS. null if invalid. */
export function parseSpread(s: unknown): bigint | null {
	if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
	try {
		const n = BigInt(s);
		return n >= 0n && n <= SPREAD_MAX_BPS ? n : null;
	} catch {
		return null;
	}
}

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
	/** Maker fee in basis points the taker pays for the fill — the maker's spread. On a peer match the
	 *  POT subsidises it up to DEFAULT_SPREAD_BPS (so the taker pays only any excess); SIGNED, so a taker
	 *  can't strip it. "0" = no fee (the old behaviour). */
	spread: string;
}

export interface Offer extends OfferCore {
	/** Ed25519 signature (hex) by `maker` over canonicalBytes(OfferCore). */
	sig: string;
}

/** A live, escrowed bilateral bet — a Matched Directional Swap. Pot = 2·stake; closing splits it
 *  directionally at the current mark. Either side may close it any time, up to the time-lock cap. */
export interface Contract {
	id: string; // the match write's id
	long: string; // pubkey holding the long side
	short: string; // pubkey holding the short side
	stake: bigint; // each side staked this; pot = 2·stake
	entry: bigint; // the oracle mark when matched
	leverage: bigint;
	nonce: string; // the originating offer (audit)
	expiryHeight: number; // auto-settles at the mark once the anchor clock reaches this (time-lock)
	bid: bigint; // one-time entry fee the taker paid to the pot for this slot — ranks the position for cap eviction
}

/** The matched-market state that lives alongside the bridge in the View. */
export interface MarketBook {
	/** Open contracts by id. */
	contracts: Map<string, Contract>;
	/** Per offer nonce: cumulative stake matched (enforces Σ fills ≤ size) + the offer's expiry
	 *  height, so the entry can be RETIRED once the offer can no longer be matched (bounds the map). */
	offerFills: Map<string, { filled: bigint; expiryHeight: number }>;
	/** DERIVED in-memory index (NOT serialized): per-account count of contract-sides held, for the
	 *  per-account position cap. Rebuilt from `contracts` on clone/deserialize, maintained during a fold. */
	posCount: Map<string, number>;
}

export function emptyBook(): MarketBook {
	return { contracts: new Map(), offerFills: new Map(), posCount: new Map() };
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
		spread: core.spread,
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
	if (parseSpread(o.spread) === null) return false; // non-negative bps ≤ SPREAD_MAX_BPS
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
 * A taker redeems part of a maker's signed offer at the current oracle `mark` (the entry price).
 * Returns the opened contract, or null if rejected (bad/expired offer, self-match, exhausted, no
 * mark, or either side can't cover — the ghost case). The match write's id becomes the contract id.
 * `fill` is clamped to the offer's remaining size (partial fill); both sides escrow `take`.
 *
 * Maker fee: the maker EARNS `feeOf(take, offer.spread)` for providing the fill (compensation for the
 * timing option a resting intent grants the taker). The fee is sourced first from the liquidity POT —
 * a community-funded maker rebate so takers can trade for free — up to DEFAULT_SPREAD_BPS and limited
 * by the deterministic `available` budget; the taker pays only the excess. Paying from the pot draws
 * the same finalized budget the backstop uses (`available`) and is recorded in `potEscrowTaken`, so
 * full and checkpoint-pruned nodes agree and the free pot can't go negative. Entry stays the clean
 * mark for both sides — the fee is an explicit transfer, never a price shift — so the bet is still
 * zero-sum and 1:1 backing holds (gBTC only moves between buckets).
 */
export function applyMatch(bridge: BridgeState, book: MarketBook, taker: string, writeId: string, offer: Offer, fill: bigint, nowHeight: number, mark: bigint, available: bigint = 0n, cap: number = MAX_OPEN_POSITIONS, bid: bigint = 0n): Contract | null {
	if (mark <= 0n) return null; // no oracle price yet → no entry
	if (!verifyOffer(offer)) return null;
	if (nowHeight > offer.expiryHeight) return null; // offer no longer takeable (soft TTL)
	if (offer.maker === taker) return null; // self-match (wash) guard
	if (book.contracts.has(writeId)) return null; // id reuse
	if (fill <= 0n) return null;
	if (posOf(book, taker) >= MAX_POSITIONS_PER_ACCOUNT || posOf(book, offer.maker) >= MAX_POSITIONS_PER_ACCOUNT) return null; // either party at its per-account cap

	const size = parseSats(offer.size)!;
	const already = book.offerFills.get(offer.nonce)?.filled ?? 0n;
	const remaining = size - already;
	if (remaining <= 0n) return null; // offer fully consumed
	const take = fill <= remaining ? fill : remaining; // partial fill

	// Maker fee = the maker's spread on the filled stake. The pot subsidises up to the default fee,
	// bounded by the finalised budget; the taker pays any remainder.
	const fee = feeOf(take, parseSpread(offer.spread)!);
	const defaultFee = feeOf(take, DEFAULT_SPREAD_BPS);
	const budget = available > 0n ? available : 0n;
	const subsidy = fee < defaultFee ? fee : defaultFee; // pot never covers above the default
	const fromPot = subsidy < budget ? subsidy : budget; // and never more than the budget allows
	const takerPays = fee - fromPot; // the taker covers whatever the pot didn't

	if (gbtcOf(bridge, offer.maker) < take) return null; // maker ghosted → no-op
	if (gbtcOf(bridge, taker) < take + takerPays + bid) return null; // taker can't cover stake + its fee share + the slot bid
	if (!makeRoom(bridge, book, cap, bid, nowHeight)) return null; // book full and the bid doesn't beat the floor → reject (wait in line)
	if (bid > 0n) { addGbtc(bridge, taker, -bid); bridge.pot += bid; } // one-time entry fee → the liquidity pot

	addGbtc(bridge, offer.maker, -take); // escrow both stakes → the contract
	addGbtc(bridge, taker, -take);
	if (fee > 0n) {
		addGbtc(bridge, offer.maker, fee, nowHeight); // maker earns the fee (a credit → resets its idle clock)
		if (takerPays > 0n) addGbtc(bridge, taker, -takerPays);
		if (fromPot > 0n) {
			bridge.pot -= fromPot; // the subsidy leaves the pot (permanently — it's spent, not escrowed)
			bridge.potEscrowTaken += fromPot; // count it against the budget so later draws can't double-spend
		}
	}
	book.offerFills.set(offer.nonce, { filled: already + take, expiryHeight: offer.expiryHeight });

	const long = offer.makerSide === "long" ? offer.maker : taker;
	const short = offer.makerSide === "long" ? taker : offer.maker;
	const c: Contract = { id: writeId, long, short, stake: take, entry: mark, leverage: parseSats(offer.leverage)!, nonce: offer.nonce, expiryHeight: nowHeight + CONTRACT_MAX_LIFE, bid };
	book.contracts.set(writeId, c);
	bumpPos(book, long, 1); // claim the per-account slots (POT exempt inside bumpPos)
	bumpPos(book, short, 1);
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
	bumpPos(book, c.long, -1); // release the per-account slots (POT exempt inside bumpPos)
	bumpPos(book, c.short, -1);
	book.contracts.delete(contractId);
	return true;
}

/** Make room for one more contract under the cap: true if the book is under cap, or if the lowest-bid
 *  position was evicted to free a slot; false (caller rejects) when full and the new bid doesn't strictly
 *  beat the floor. Eviction settles the floor at its ENTRY — stakes returned, no PnL, like a time-lock
 *  expiry — so it's deterministic + base-independent. Floor = smallest bid (ties: smallest id). O(n) at
 *  capacity; a bid-ordered index can make it O(log n) if saturation ever becomes real. */
function makeRoom(bridge: BridgeState, book: MarketBook, cap: number, newBid: bigint, height: number): boolean {
	if (book.contracts.size < cap) return true;
	let floorId: string | null = null;
	let floorBid = 0n;
	for (const [id, c] of book.contracts) {
		if (floorId === null || c.bid < floorBid || (c.bid === floorBid && id < floorId)) {
			floorId = id;
			floorBid = c.bid;
		}
	}
	if (floorId === null || newBid <= floorBid) return false; // can't outbid the floor → reject (wait in line)
	applySettle(bridge, book, floorId, book.contracts.get(floorId)!.entry, height); // evict: unwind at entry
	return true;
}

/** A party's open-position count (contract-sides held). */
function posOf(book: MarketBook, who: string): number {
	return book.posCount.get(who) ?? 0;
}
/** Adjust a party's open-position count. The POT backstop isn't an account, so it's exempt from the cap. */
function bumpPos(book: MarketBook, who: string, delta: number): void {
	if (who === POT) return;
	const n = (book.posCount.get(who) ?? 0) + delta;
	if (n <= 0) book.posCount.delete(who);
	else book.posCount.set(who, n);
}
/** Rebuild `posCount` from `contracts` — the source of truth. Called at every clone/deserialize boundary
 *  so a full node and a checkpoint-resumed node always start a fold from the identical index (no fork). */
export function rebuildPosCount(book: MarketBook): void {
	book.posCount = new Map();
	for (const c of book.contracts.values()) {
		bumpPos(book, c.long, 1);
		bumpPos(book, c.short, 1);
	}
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
 *
 * The pot is a PAID maker too (the same deal a peer maker gets): the taker pays it the DEFAULT-spread
 * fee on top of the stake, which flows into `bridge.pot` — so providing last-resort liquidity grows
 * the backstop rather than just risking it.
 */
export function applyMatchPot(bridge: BridgeState, book: MarketBook, taker: string, writeId: string, takerSide: Side, fill: bigint, leverage: bigint, nowHeight: number, mark: bigint, available: bigint, cap: number = MAX_OPEN_POSITIONS, bid: bigint = 0n): Contract | null {
	if (mark <= 0n) return null; // no market price yet → no entry
	if (taker === POT) return null; // the pot can't take its own side
	if (book.contracts.has(writeId)) return null; // id reuse
	if (fill <= 0n) return null;
	if (leverage < MIN_OFFER_LEVERAGE || leverage > MAX_OFFER_LEVERAGE) return null;
	if (posOf(book, taker) >= MAX_POSITIONS_PER_ACCOUNT) return null; // taker at its per-account cap (the POT side is exempt)

	const budget = available > 0n ? available : 0n;
	const takerFree = gbtcOf(bridge, taker);
	if (takerFree < bid) return null; // can't even cover the slot bid
	// The taker pays the pot a DEFAULT-spread fee AND the slot bid, so clamp the stake so bid + stake + its
	// fee fit the taker's balance (as well as the offered fill and the pot's finalized budget).
	const maxAffordable = ((takerFree - bid) * BPS) / (BPS + DEFAULT_SPREAD_BPS);
	let take = fill;
	if (take > maxAffordable) take = maxAffordable; // taker can't cover stake + fee → partial
	if (take > budget) take = budget; // pot's finalized budget → partial
	if (take <= 0n) return null; // taker broke or pot exhausted → no-op
	const fee = feeOf(take, DEFAULT_SPREAD_BPS); // the pot's maker fee
	if (!makeRoom(bridge, book, cap, bid, nowHeight)) return null; // book full and the bid doesn't beat the floor → reject

	if (bid > 0n) { addGbtc(bridge, taker, -bid); bridge.pot += bid; } // one-time entry fee → the liquidity pot
	addGbtc(bridge, taker, -take); // taker escrows its stake
	if (fee > 0n) {
		addGbtc(bridge, taker, -fee); // taker pays the pot its maker fee
		bridge.pot += fee; // ...which grows the backstop (the pot earns for providing liquidity)
	}
	bridge.pot -= take; // pot escrows the matching counter-stake (≥ 0 by the budget invariant)
	bridge.potEscrowTaken += take; // committed counter the budget is measured against
	const long = takerSide === "long" ? taker : POT;
	const short = takerSide === "long" ? POT : taker;
	const c: Contract = { id: writeId, long, short, stake: take, entry: mark, leverage, nonce: writeId, expiryHeight: nowHeight + CONTRACT_MAX_LIFE, bid };
	book.contracts.set(writeId, c);
	bumpPos(book, long, 1); // claim the taker's per-account slot (POT side exempt inside bumpPos)
	bumpPos(book, short, 1);
	return c;
}

/**
 * Auto-unwind every contract whose time-lock has elapsed (expiryHeight ≤ nowHeight): settle at
 * its OWN ENTRY price, i.e. return each side its stake (no PnL). A swap can't outlive its cap,
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
