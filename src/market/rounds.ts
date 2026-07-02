/**
 * Gavl Rounds — the 1-click bull/bear primitive: parimutuel up/down rounds derived from anchor
 * height. No scheduler, no listing op, no order book: round N IS the height interval
 * [N·ROUND_LEN, (N+1)·ROUND_LEN). While a round's window is open anyone enters UP or DOWN with a
 * stake; at the window's end the round LOCKS (strike = the first confidence-OK oracle write at or
 * after the boundary); one window later it CLOSES (same rule) and settles: winners split the losing
 * pool pro-rata, a small vig + integer dust go to the liquidity pot, and the round deletes itself.
 * Always one round accepting + one live → a hammer every ROUND_LEN anchors.
 *
 * POT-SEEDING (the pot's one outflow): at each round's LOCK — the moment the strike is set — the
 * liquidity pot stakes the THIN side up to the imbalance, budget-capped per fold (see RoundSeed).
 * The vig/demurrage the pot collects thus flows back out to the next cycle's opposite end, and a
 * one-sided round becomes settleable instead of refunding. The seed is pool-level (no entry slot,
 * invisible to top-N admission) and moves LAST — set only after the lock, it can't be positioned
 * against.
 *
 * Determinism (the reason for every shape here):
 *   - STRIKE/CLOSE are set inside the market.report APPLY — "the first qualifying write in fold
 *     order" — so full and checkpoint-resumed nodes can never disagree (the mark-at-sweep trap is
 *     structurally avoided).
 *   - The SEED BUDGET derives from the FOLD BASE's pot, never the live mid-fold pot (see btc.ts
 *     computeView) — a checkpoint-resumed node's live pot differs mid-fold, the base's doesn't.
 *   - Refunds credit at write- or constant-derived heights, never the fold's moving nowHeight.
 *   - Admission is TOP-N BY STAKE: a full round admits only a strictly-bigger stake, evicting (and
 *     refunding) the floor — squatting costs real capital; ties keep the incumbent. Stake IS the bid.
 *   - Everything only MOVES gBTC (balance ⇄ pools ⇄ pot ⇄ seeds), so 1:1 backing holds; pools and
 *     seeds are a conservation bucket (see marketConserved).
 *
 * PoST is the clock and the doorman: heights only advance by farmed anchors (the strike/close
 * moments are consensus), and every entry is a cooldown-stamped write (spam costs space-and-time).
 */

import { addGbtc, gbtcOf } from "../custody/bridge.ts";
import type { BridgeState } from "../custody/bridge.ts";

// ── consensus constants (every node must agree; R0-benchmarked) ──

/** Anchors per round window (~15 min at 60s/anchor). Entries for round N land in its window;
 *  lock at (N+1)·LEN, close at (N+2)·LEN — pipelined, so one round accepts while the prior runs. */
export const ROUND_LEN = 15;
/** Entries must certify at least this many anchors BEFORE lock — kills last-anchor info sniping. */
export const ROUND_ENTRY_CUTOFF = 1;
/** Max entries per round (R0: 102 B each → ~1 MB/round). Full → top-N-by-stake admission. */
export const MAX_ROUND_ENTRIES = 10_000;
/** Smallest NEW entry (dust floor — an entry must be worth its state). Top-ups may be smaller. */
export const MIN_ROUND_STAKE = 1_000n;
/** The vig on the losing pool, in basis points → the liquidity pot (with integer-division dust). */
export const ROUND_VIG_BPS = 300n;
/** Strike/close accept only oracle updates with conf ≤ this many bps of price ("clear photo" rule);
 *  a wider update is skipped and the next one (≈5s later) is tried. Signed feeds carry conf 0. */
export const ROUND_CONF_MAX_BPS = 50n;
/** No qualifying close this many anchors past the close boundary → the round refunds (oracle dark). */
export const ROUND_DARK_TIMEOUT = 60;

// ── state ──

export type RoundSide = "up" | "down";

export interface RoundEntry {
	side: RoundSide;
	stake: bigint; // merged across an account's re-entries (one account = one slot, one side)
}

/** One live round. Created by its first entry; deleted at settle/refund — so the map only ever
 *  holds the accepting round, the live round, and (rarely) stragglers awaiting the dark timeout. */
export interface Round {
	idx: number;
	strike: bigint | null; // set by the first conf-OK oracle write ≥ lock boundary
	poolUp: bigint;
	poolDown: bigint;
	/** The pot's thin-side stake, placed at LOCK (see roundsOnOracle). POOL-LEVEL fields, NOT
	 *  entries: they take no slot and are invisible to top-N admission. Settle/refund math uses
	 *  TOTALS (pool + seed); a winning seed earns like a stake and drains back to the pot. */
	seedUp: bigint;
	seedDown: bigint;
	entries: Map<string, RoundEntry>; // pubkey → entry
}

export type Rounds = Map<number, Round>;

export function emptyRounds(): Rounds {
	return new Map();
}

// ── the height geometry (pure) ──

export const roundIdxAt = (height: number): number => Math.floor(height / ROUND_LEN);
export const lockBoundary = (idx: number): number => (idx + 1) * ROUND_LEN;
export const closeBoundary = (idx: number): number => (idx + 2) * ROUND_LEN;
/** Is `height` inside round `idx`'s entry window (its own window, minus the cutoff tail)? */
export const entryOpen = (idx: number, height: number): boolean => roundIdxAt(height) === idx && height < lockBoundary(idx) - ROUND_ENTRY_CUTOFF;

/** gBTC escrowed across all live round pools + pot seeds — the conservation bucket. */
export function roundsEscrowTotal(rounds: Rounds): bigint {
	let t = 0n;
	for (const r of rounds.values()) t += r.poolUp + r.poolDown + r.seedUp + r.seedDown;
	return t;
}

/** The "clear photo" rule: an oracle update participates in strike/close only if its confidence
 *  interval is tight relative to price (conf·10000 ≤ price·CONF_MAX_BPS). conf 0 always passes. */
export function confOk(price: bigint, conf: bigint): boolean {
	return price > 0n && conf * 10_000n <= price * ROUND_CONF_MAX_BPS;
}

// ── enter (top-N-by-stake admission) ──

/**
 * Apply a round.enter: escrow `stake` from `who` into round `idx`'s `side` pool. Rejects (clean
 * no-op) outside the entry window, on a side switch, under the dust floor, or when full and not
 * strictly out-staking the floor. A full round evicts its floor entry (smallest stake; ties keep
 * the incumbent — floor picked by smallest stake then lexicographically smallest pubkey) and
 * refunds it at `bornHeight`. Re-entries by the same account MERGE (same side only) — topping up
 * improves your rank and needs no admission check (the slot is already held).
 */
export function applyRoundEnter(bridge: BridgeState, rounds: Rounds, who: string, idx: number, side: RoundSide, stake: bigint, bornHeight: number, maxEntries: number = MAX_ROUND_ENTRIES): boolean {
	if (stake <= 0n) return false;
	if (side !== "up" && side !== "down") return false;
	if (!entryOpen(idx, bornHeight)) return false; // wrong round for this write's certified height, or inside the cutoff
	const r = rounds.get(idx) ?? { idx, strike: null, poolUp: 0n, poolDown: 0n, seedUp: 0n, seedDown: 0n, entries: new Map<string, RoundEntry>() };

	const mine = r.entries.get(who);
	if (mine) {
		// top-up: the slot is already held — same side only, any positive amount.
		if (mine.side !== side) return false;
		if (gbtcOf(bridge, who) < stake) return false;
		addGbtc(bridge, who, -stake);
		mine.stake += stake;
	} else {
		if (stake < MIN_ROUND_STAKE) return false;
		if (gbtcOf(bridge, who) < stake) return false;
		if (r.entries.size >= maxEntries) {
			// full → find the floor (smallest stake; tie → smallest pubkey) and require a STRICT out-stake.
			let floorKey: string | null = null;
			let floorEntry: RoundEntry | null = null;
			for (const [k, e] of r.entries) {
				if (floorEntry === null || e.stake < floorEntry.stake || (e.stake === floorEntry.stake && k < floorKey!)) {
					floorKey = k;
					floorEntry = e;
				}
			}
			if (!floorEntry || stake <= floorEntry.stake) return false; // ties keep the incumbent
			addGbtc(bridge, floorKey!, floorEntry.stake, bornHeight); // evict: refund the floor (a credit — resets its idle clock)
			if (floorEntry.side === "up") r.poolUp -= floorEntry.stake;
			else r.poolDown -= floorEntry.stake;
			r.entries.delete(floorKey!);
		}
		addGbtc(bridge, who, -stake);
		r.entries.set(who, { side, stake });
	}
	if (side === "up") r.poolUp += stake;
	else r.poolDown += stake;
	rounds.set(idx, r);
	return true;
}

// ── settle / refund (called from the market.report apply + the dark sweep) ──

/** Refund every entry its stake (credited at `height` — write- or constant-derived, never the
 *  fold's moving clock), send any pot seed home, and delete the round. Used for: tie, one-sided
 *  round, no strike by close, oracle dark past the timeout. */
export function refundRound(bridge: BridgeState, rounds: Rounds, r: Round, height: number): void {
	for (const [who, e] of r.entries) addGbtc(bridge, who, e.stake, height);
	bridge.pot += r.seedUp + r.seedDown; // the seed placed at lock goes back to the pot
	rounds.delete(r.idx);
}

/** Settle a closed round at `close` vs its strike: winners split the losing TOTAL (stakes + pot
 *  seed) pro-rata; the vig and the integer-division dust go to the pot. All checks and denominators
 *  use TOTALS, so a round whose thin side is only pot-seed settles instead of refunding. The pot's
 *  winning seed earns exactly like a stake (seed back + pro-rata share); a losing seed just stays
 *  distributed (it left the pot at lock). Tie or one-sided-by-total → refund. Deletes the round.
 *  Returns what the pot gained — pools + seeds drain to exactly zero across winners + pot. */
export function settleRound(bridge: BridgeState, rounds: Rounds, r: Round, close: bigint, height: number): bigint {
	const totalUp = r.poolUp + r.seedUp;
	const totalDown = r.poolDown + r.seedDown;
	if (r.strike === null || close === r.strike || totalUp === 0n || totalDown === 0n) {
		refundRound(bridge, rounds, r, height); // tie / one-sided / shouldn't-happen → everyone (pot included) made whole
		return 0n;
	}
	const upWins = close > r.strike;
	const winSeed = upWins ? r.seedUp : r.seedDown;
	const winTotal = (upWins ? r.poolUp : r.poolDown) + winSeed;
	const loseTotal = upWins ? totalDown : totalUp;
	const vig = (loseTotal * ROUND_VIG_BPS) / 10_000n;
	const dist = loseTotal - vig;
	let paidShares = 0n;
	for (const [who, e] of r.entries) {
		if ((e.side === "up") !== upWins) continue; // losers' stakes stay in the pool → distributed
		const share = (e.stake * dist) / winTotal;
		paidShares += share;
		addGbtc(bridge, who, e.stake + share, height); // stake back + pro-rata winnings (a credit)
	}
	const potShare = (winSeed * dist) / winTotal; // the pot's seed wins like any stake
	paidShares += potShare;
	// pot: its winning seed back + its winnings + vig + division dust (dust counts the pot's share too).
	const toPot = winSeed + potShare + vig + (dist - paidShares);
	rounds.delete(r.idx);
	return toPot;
}

/**
 * The fold's per-fold pot-seeding budget, computed ONCE at fold start from the FOLD BASE's pot
 * (never the live mid-fold pot — see btc.ts computeView) and threaded through every market.report
 * apply so `drawn` accumulates across the fold's locks. The budget is per-FOLD from the fold's
 * base: checkpoint cadence (every 16 finalized anchors ≈ one epoch) makes this "≤10% of the
 * finalized pot per epoch" in production.
 */
export interface RoundSeed {
	budget: bigint; // base pot / 10 (0 with no base → seeding off)
	drawn: bigint; // total seeded so far this fold (monotonic within the fold)
}

/**
 * POT-SEEDING at LOCK: the moment a strike is set, the pot stakes the THIN side up to the
 * imbalance, capped by the fold's remaining budget. Seed ONLY at lock — the pot moves last, so it
 * can't be positioned against; a round the pot fully balances has equal totals. Only rounds with
 * at least one entry exist in the map, so an empty round never draws a seed.
 */
function seedAtLock(bridge: BridgeState, r: Round, seed: RoundSeed): void {
	const totalUp = r.poolUp + r.seedUp;
	const totalDown = r.poolDown + r.seedDown;
	if (totalUp === totalDown) return; // already balanced
	const need = totalUp > totalDown ? totalUp - totalDown : totalDown - totalUp;
	const avail = seed.budget - seed.drawn;
	const take = need < avail ? need : avail;
	if (take <= 0n) return;
	bridge.pot -= take; // safe: within a fold the pot only grows (vig/refunds) or shrinks by these
	seed.drawn += take; //   draws, so live pot ≥ base pot − drawn ≥ base pot − base pot/10 ≥ 0.
	if (totalUp > totalDown) r.seedDown += take;
	else r.seedUp += take;
}

/**
 * Feed one VERIFIED oracle update (price+conf, certified at `bornHeight`) to the rounds — called
 * from the market.report apply, so it's "the first qualifying write in fold order": deterministic
 * and base-independent. Sets strikes (then pot-seeds the thin side, budget permitting), settles
 * closes, refunds rounds that never got a strike. Returns the pot's gain (the caller credits
 * bridge.pot). Omitting `roundSeed` (pure/unit callers) leaves a zero budget — seeding off.
 */
export function roundsOnOracle(bridge: BridgeState, rounds: Rounds, price: bigint, conf: bigint, bornHeight: number, roundSeed: RoundSeed = { budget: 0n, drawn: 0n }): bigint {
	if (rounds.size === 0) return 0n;
	const ok = confOk(price, conf);
	let toPot = 0n;
	for (const idx of [...rounds.keys()].sort((a, b) => a - b)) {
		const r = rounds.get(idx)!;
		if (r.strike === null) {
			if (bornHeight >= closeBoundary(idx)) refundRound(bridge, rounds, r, bornHeight); // never struck in time
			else if (bornHeight >= lockBoundary(idx) && ok) {
				r.strike = price;
				seedAtLock(bridge, r, roundSeed); // the lock IS the seeding moment
			}
		} else if (bornHeight >= closeBoundary(idx) && ok) {
			toPot += settleRound(bridge, rounds, r, price, bornHeight);
		}
	}
	return toPot;
}

/** End-of-fold safety net: a round with no qualifying close this long past its boundary refunds.
 *  Credits at the DEADLINE height (a per-round constant), so every node — whatever height its fold
 *  first crossed the deadline at — writes the identical state (base-independent, no fork). */
export function sweepDarkRounds(bridge: BridgeState, rounds: Rounds, nowHeight: number): void {
	for (const r of [...rounds.values()]) {
		const deadline = closeBoundary(r.idx) + ROUND_DARK_TIMEOUT;
		if (nowHeight >= deadline) refundRound(bridge, rounds, r, deadline);
	}
}
