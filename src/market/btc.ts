/**
 * Gavl state — the BTC bull/bear MATCHED market, a pure fold of the write set.
 *
 *   computeView(writes) -> { bridge, oracle, custody, book }
 *
 * The whole product: peers broadcast intents to long/short BTC; a taker takes the
 * opposite side; the match escrows BOTH peers' gBTC and opens a bilateral, zero-sum,
 * fully-collateralized contract settled against the oracle mark. There is NO pool, so
 * the protocol is never a counterparty and reserves can't be drained. The intent
 * match/settle logic lives in ./intent.ts; this fold wires it (match.open / contract.
 * settle) alongside the gBTC bridge and the oracle.
 *
 * Pricing = a Pyth feed, NO reporter. A CHANNEL IS A MARKET: the channel name encodes a Pyth feed id
 * (`label::pyth::feedId`), and ANYONE may relay the latest signed update. The fold verifies it
 * locally — the Wormhole guardian quorum + the Merkle proof (see ./pyth.ts) — so a forged update
 * fails and there's no reporter to run or trust. The fold uses the POSTED, verified price
 * (deterministic); what's banned is a node using its own live fetch as the mark (that diverges).
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "./ops.ts";
import { isOp } from "./ops.ts";
import { finalizedOrdering, orderingFor } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";
import { verifyPythUpdate } from "./pyth.ts";
import { verifySignedQuorum } from "./signed-feed.ts";
import { emptyBridge, gbtcOf as bridgeGbtcOf, addGbtc, totalGbtc, bondedTotal, pendingTotal, mintFromDeposit, mintCeiling, withdrawCap, transferGbtc, requestWithdrawal, completeWithdrawal, recordClaim, recordBroadcast, bond, requestUnbond, releaseMatured, slash, pruneStaleClaims, DEMURRAGE_DAY, DEMURRAGE_GRACE_DAYS, DEMURRAGE_CUTOFF_DAYS, DEMURRAGE_KEEP_NUM, DEMURRAGE_KEEP_DEN, DEMURRAGE_DUST } from "../custody/bridge.ts";
import type { BridgeState } from "../custody/bridge.ts";
import { equivocationCulprit } from "../custody/slashing.ts";
import { emptyBook, escrowedInContracts, applyMatch, applyMatchPot, applySettle, pruneExpiredOffers, settleExpired } from "./intent.ts";
import type { Side } from "./intent.ts";
import type { MarketBook } from "./intent.ts";
import { verify as verifyThreshold } from "../custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest } from "../custody/attestation.ts";
import { fromHex } from "../det/canonical.ts";

/**
 * The channel's market price. A CHANNEL IS A MARKET: the channel name encodes the instrument's Pyth
 * feed (`label::pyth::feedId`), so there's no in-state registry and no per-price vote — anyone relays
 * a Wormhole-attested update and the fold verifies it (the feed id, passed into the fold from the
 * name, is what it matches against). Each channel is its own economy (own ledger/pot), so a market is
 * a sandbox: a malicious market can't touch funds in another channel. Only the price lives in state;
 * the feed id is the channel's identity, not consensus data.
 */
export interface MarketPrice {
	/** Latest verified price (null until the first update is relayed). The integer mark; contracts use
	 *  it ratio-wise, so the fold never needs the scale — but display does (real value = price·10^expo). */
	price: bigint | null;
	/** Pyth's decimal exponent for display (e.g. −8). */
	expo: number;
	/** Pyth publish-time (unix seconds) — replay/ordering guard (newer wins). */
	seq: number;
	/** Certified height of the last update — drives staleness checks. */
	at: number;
}

/** Updates older than this many anchors are STALE — a market won't match/settle on a price that
 *  stopped refreshing, so a dead feed can't freeze trades at an old number. */
export const MARKET_STALE_AFTER = 4_320; // ~3 days at 60s/anchor

/** A fresh, unpriced market-price slot. */
export function emptyMarket(): MarketPrice {
	return { price: null, expo: 0, seq: -1, at: 0 };
}

export interface CustodyState {
	/** The threshold-custody fund's group key (hex), or null until genesis announces it.
	 *  The Taproot deposit address derives from this; it is permanent (set once). */
	fundKey: string | null;
	/** The epoch the fund was established in (−1 until announced). */
	epoch: number;
}

export interface View {
	/** The BTC bridge: gBTC balances + BTC reserves + processed deposits + pending
	 *  withdrawals. gBTC is the collateral — a 1:1 claim on real Bitcoin in the fund. */
	bridge: BridgeState;
	/** This channel's single market price (the Pyth feed id comes from the channel name). */
	market: MarketPrice;
	/** The threshold-custody fund key, announced on-chain at genesis (committee mode). */
	custody: CustodyState;
	/** The peer-to-peer intent market: bilateral matched contracts + offer-fill tracking.
	 *  The matched, zero-sum, can't-deplete-reserves core (replaced the old pool). */
	book: MarketBook;
}

/** Active gBTC balance of `pubkey`. */
export function gbtcOf(view: View, pubkey: string): bigint {
	return bridgeGbtcOf(view.bridge, pubkey);
}

/**
 * The 1:1 backing invariant: every gBTC — free, bonded, escrowed in an open matched
 * contract, held in the liquidity pot, or burned-and-pending — is backed by a satoshi in
 * reserves. Match/settle/demurrage only MOVE gBTC between these buckets, never mint, so this
 * always holds.
 */
export function marketConserved(view: View): boolean {
	return view.bridge.reserves === totalGbtc(view.bridge) + bondedTotal(view.bridge) + escrowedInContracts(view.book) + pendingTotal(view.bridge) + view.bridge.pot;
}

export function parseAmount(s: string): bigint | null {
	if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
	try {
		const n = BigInt(s);
		return n > 0n ? n : null;
	} catch {
		return null;
	}
}

function cmpWrite(a: Write, b: Write): number {
	if (a.ts !== b.ts) return a.ts - b.ts;
	if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
	return a.seq - b.seq;
}

/**
 * Is a bridge mint/settle authorized? Once a committee fund key is published on-chain
 * (committee custody), authority is a BIP340 THRESHOLD signature by that group key over
 * the attestation digest — so a quorum of the committee, each having independently
 * verified the on-chain fact, must have agreed; no single key can mint or settle. The
 * write's author is irrelevant (anyone may relay a committee-signed attestation). There is
 * NO single-key fallback: with no announced fund key, minting/settling is impossible — a
 * market can't issue claims on BTC before the custody that holds the BTC exists.
 */
function attestationAuthorized(view: View, _w: Write, digest: Uint8Array, sig: string | undefined): boolean {
	// No fund, no mint: a market can't issue claims on BTC before the custody that holds the BTC
	// exists. The ONLY authority is a threshold signature by the on-chain-announced group key — there
	// is no single-key fallback (Option A: no public default attestor, no pre-genesis mint window).
	if (!view.custody.fundKey || typeof sig !== "string") return false;
	try {
		return verifyThreshold(fromHex(sig), digest, fromHex(view.custody.fundKey));
	} catch {
		return false; // malformed sig/key → unauthorized
	}
}

export interface ViewOptions {
	order?: (a: Write, b: Write) => number;
	/** Anchor-clock "now" — drives funding + (later) mark finality. */
	nowHeight?: number;
	/** Per-write certifying-anchor height (from finalizedOrdering) — the STABLE height a
	 *  write happened at, used for height-timed effects (unbond maturity) that must not
	 *  drift as the fold's global `nowHeight` advances. */
	bornAt?: Map<string, number>;
	/** Resume from this state (a checkpoint): the fold starts from a DEEP COPY of `base`
	 *  and applies only `writes` on top. Folding [post-checkpoint writes] onto the
	 *  checkpoint view equals folding the full history — the basis for never replaying
	 *  from 0. Height-timed effects act on state carried in `base` (bonds live there). */
	base?: View;
	/** The liquidity-backstop budget, taken from the FINALIZED view (`pot` = its free pot,
	 *  `taken` = its lifetime `potEscrowTaken`). A `match.pot` may draw against
	 *  `(pot + taken) − currentPotEscrowTaken` — i.e. only finalized pot capital, which every node
	 *  agrees on, so the budget is deterministic and the free pot can't go negative. Absent (pure
	 *  folds / no finalized state yet) → budget 0 → the backstop is simply unavailable. */
	backstop?: { pot: bigint; taken: bigint };
	/** The channel's market definition (what backs the price). When set, `market.report` carries a
	 *  SIGNED update anyone may relay — the fold verifies an M-of-N quorum against this def's trust
	 *  anchor (Pyth's guardian set, or a generic signer set) and matches the feed/set. A per-channel
	 *  constant (same for every node), so the fold is deterministic. Absent → a transfers-only channel. */
	market?: MarketDef;
}

/**
 * A channel's market = where its price comes from, and the trust anchor that signs it. Both kinds are
 * SIGNED-by-a-QUORUM + relayed-by-anyone — the fold verifies an M-of-N signature set, never trusting
 * the relayer or any single signer. `pyth` uses Wormhole's guardian set (13-of-19), committed by
 * feed id; `signed` uses any Ed25519 signer set you stand up, committed by `signerSetHash`. The
 * channel NAME encodes this (see daemon parseChannel: `label::pyth::feedId` / `label::signed::setHash`).
 */
export type MarketDef = { kind: "pyth"; feedId: string } | { kind: "signed"; signerSet: string };

/**
 * Demurrage — the RAM ledger's "balances can't sit forever" rule, turned into liquidity. State
 * lives in RAM, so an idle balance that never moves is just an unbounded entry; rather than cap it,
 * we let IDLE (free) gBTC decay and reappropriate it into the liquidity POT (which backstops
 * trades). Per balance, from its idle clock `chargeFrom` (= last-credit + grace):
 *   - before chargeFrom: untouched (the ~1-week grace),
 *   - after: −20%/day,
 *   - at the 1-month cutoff (or once it dips below the dust floor): take whatever's left.
 * The whole lifecycle is ≤ 1 month for ANY balance — the % decay is the gentle warning, the
 * cutoff the hard guarantee. The drag goes to `bridge.pot` (a conservation bucket), NOT
 * redistributed per-fold: redistribution to the active-contract set is path-dependent (which
 * contracts are open at a fold differs by checkpoint base → divergent appRoot → fork). The pot
 * is just a counter, so it's base-independent (= cumulative idle decay). It only MOVES gBTC
 * (idle → pot), never mints/burns, so 1:1 backing holds. The pot is the backstop's capital
 * (`applyMatchPot`): reclaimed idle balances become the counterparty that lets someone trade.
 */
function accrueDemurrage(view: View, nowHeight: number): void {
	const b = view.bridge;
	const cutoffAge = DEMURRAGE_CUTOFF_DAYS * DEMURRAGE_DAY; // age past `since` at which we take it all
	for (const [k, bal] of [...b.gbtc]) {
		const e = b.chargeFrom.get(k);
		if (e === undefined) {
			b.chargeFrom.set(k, { since: nowHeight, charged: nowHeight + DEMURRAGE_GRACE_DAYS * DEMURRAGE_DAY }); // unstamped → grace from now
			continue;
		}
		if (nowHeight - e.since >= cutoffAge) {
			b.pot += bal; // past the 1-month cutoff (measured from the FIXED idle-start) → take it all
			addGbtc(b, k, -bal); // (deletes the entry + its clock)
			continue;
		}
		if (nowHeight <= e.charged) continue; // still in grace / nothing new to charge
		const days = Math.floor((nowHeight - e.charged) / DEMURRAGE_DAY);
		if (days <= 0) continue;
		let kept = bal;
		for (let i = 0; i < days; i++) kept = (kept * DEMURRAGE_KEEP_NUM) / DEMURRAGE_KEEP_DEN; // −20%/day, per-day floor
		const charge = bal - kept;
		if (charge > 0n) {
			addGbtc(b, k, -charge);
			b.pot += charge;
		}
		e.charged += days * DEMURRAGE_DAY; // advance the charged-through boundary (since stays fixed)
		const left = b.gbtc.get(k) ?? 0n;
		if (left > 0n && left < DEMURRAGE_DUST) {
			b.pot += left; // the % tail isn't worth a slot → take it into the pot
			addGbtc(b, k, -left);
		}
	}
}

/**
 * Deep-copy a View so a resumed fold can mutate freely without touching the cached/snapshot base.
 * A direct structural clone — Maps/Sets rebuilt, every nested value object the fold mutates in
 * place (chargeFrom's `charged`, pending/unbonding/claims/readings/contracts/offerFills) copied —
 * instead of a serialize→sort→stringify→parse round-trip. Same result, far cheaper. The
 * checkpoint-determinism tests (full fold vs base-resumed fold) guard that this copies everything
 * the serializer would: a dropped field would diverge the resumed viewRoot.
 */
export function cloneView(v: View): View {
	const b = v.bridge;
	const cp = <T extends object>(m: Map<string, T>): Map<string, T> => new Map([...m].map(([k, x]) => [k, { ...x }]));
	return {
		bridge: {
			gbtc: new Map(b.gbtc), // bigint values are immutable → shallow Map copy is a full copy
			reserves: b.reserves,
			processed: new Set(b.processed),
			pending: b.pending.map((p) => ({ ...p })),
			depositors: new Set(b.depositors),
			claims: cp(b.claims),
			broadcasts: new Map(b.broadcasts),
			bonds: new Map(b.bonds),
			unbonding: cp(b.unbonding),
			mintedTotal: b.mintedTotal,
			paidOut: b.paidOut,
			chargeFrom: cp(b.chargeFrom),
			pot: b.pot,
			potEscrowTaken: b.potEscrowTaken,
			withdrawnTotal: b.withdrawnTotal,
		},
		market: { ...v.market },
		custody: { fundKey: v.custody.fundKey, epoch: v.custody.epoch },
		book: { contracts: cp(v.book.contracts), offerFills: cp(v.book.offerFills) },
	};
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = opts.base
		? cloneView(opts.base) // deep copy so the cached/snapshot base isn't mutated
		: {
				bridge: emptyBridge(),
				market: emptyMarket(),
				custody: { fundKey: null, epoch: -1 },
				book: emptyBook(),
			};
	const nowHeight = opts.nowHeight ?? 0;
	// Total finalized pot capital the backstop may commit (free + lifetime-drawn); a match.pot
	// draws against this minus the live draw counter. Source, in order: an explicit budget
	// (tests), else the CHECKPOINT BASE's pot — the finalized, network-agreed snapshot every node
	// resumes from, so the budget is identical for full and pruned nodes and across tip/final/
	// appRoot folds (which all share that base). No base yet (pre-first-checkpoint) → 0.
	const backstop = opts.backstop ?? (opts.base ? { pot: opts.base.bridge.pot, taken: opts.base.bridge.potEscrowTaken } : null);
	const backstopBudget = backstop ? backstop.pot + backstop.taken : 0n;
	// Per-epoch custody ceiling: custodied BTC ≤ TVL_PER_BOND × the FINALIZED committee bond, read from
	// the SAME checkpoint base the backstop budget uses (so it's identical for full and pruned nodes, and
	// — since CHECKPOINT_EVERY == epochLength — advances exactly one epoch at a time). No base yet
	// (pre-first-checkpoint / genesis) → bond 0 → just the bootstrap floor.
	const custodyCeiling = mintCeiling(opts.base ? bondedTotal(opts.base.bridge) : 0n);
	// Vector B outflow budget (absolute, mirrors backstopBudget): from the SAME checkpoint base, the
	// epoch may withdraw up to withdrawCap(finalized reserves); `available` per write = this minus the
	// live withdrawnTotal. No base yet (pre-first-checkpoint / full-from-genesis) → undefined → uncapped.
	const withdrawBudget = opts.base ? opts.base.bridge.withdrawnTotal + withdrawCap(opts.base.bridge.reserves) : undefined;
	for (const w of [...writes].sort(cmp)) {
		const op = w.payload as Op | null;
		// Effects timed by height (unbond maturity) use the write's STABLE certifying
		// height (bornAt) so they don't drift as the global nowHeight advances; others
		// use nowHeight (the current anchor clock).
		if (isOp(op)) applyOp(view, w, op, nowHeight, opts.bornAt?.get(w.id) ?? nowHeight, backstopBudget, custodyCeiling, withdrawBudget, opts.market);
	}
	releaseMatured(view.bridge, nowHeight); // matured unbonds → free gBTC (on the anchor clock)
	settleExpired(view.bridge, view.book, nowHeight); // time-locked directional swaps unwind at entry (base-independent)
	accrueDemurrage(view, nowHeight); // idle gBTC bleeds to capital working in open contracts
	pruneExpiredOffers(view.book, nowHeight); // drop fill-tracking for offers that can no longer be matched
	pruneStaleClaims(view.bridge, nowHeight); // retire deposit-mint requests unminted past the reclaim grace
	return view;
}

/** Mark price for the channel's market = the latest verified Pyth price, or null if unpriced or STALE
 *  (updates stopped past MARKET_STALE_AFTER). `nowHeight` gates staleness; pass the write's certified
 *  height so it's base-independent (omit → no stale check). */
export function mark(view: View, nowHeight?: number): bigint | null {
	const m = view.market;
	if (m.price === null) return null;
	if (nowHeight !== undefined && nowHeight - m.at >= MARKET_STALE_AFTER) return null; // source went dark
	return m.price;
}

/**
 * Finality-bound view: fold only what the anchor `k` deep certifies, in the
 * PoST-bound order. Composes the pure consensus ordering with this app fold —
 * consensus never imports app state; the app calls consensus.
 */
export function finalizedView(writes: Write[], anchors: AnchorChain, k: number, base?: View, market?: MarketDef): View {
	const { included, order, bornAt, nowHeight } = finalizedOrdering(writes, anchors, k);
	if (nowHeight === null) return base ? computeView([], { base, market }) : computeView([], { market });
	return computeView(included, { order, nowHeight, bornAt, base, market });
}

/**
 * The application state a SPECIFIC anchor commits to — the deterministic view of
 * exactly the writes its heads certify, in the chain-induced order. This is what an
 * anchor's `appRoot` is `viewRoot()` of; the producer computes it when mining and a
 * verifier recomputes it to accept the anchor. Optionally resumes from a checkpoint
 * `base` (a pruned node folds forward from its snapshot instead of from genesis).
 */
export function viewAtAnchor(writes: Write[], anchors: AnchorChain, anchorId: string, base?: View, market?: MarketDef): View {
	const anchor = anchors.get(anchorId);
	const { included, order, bornAt, nowHeight } = orderingFor(writes, anchors, anchor ?? null);
	if (nowHeight === null) return base ? computeView([], { base, market }) : computeView([], { market });
	return computeView(included, { order, nowHeight, bornAt, base, market });
}

function applyOp(view: View, w: Write, op: Op, nowHeight: number, bornHeight: number, backstopBudget = 0n, custodyCeiling = 0n, withdrawBudget?: bigint, market?: MarketDef): void {
	switch (op.kind) {
		case "bridge.deposit": {
			// Mint gBTC 1:1 from a VERIFIED BTC deposit. Authorized ONLY by the committee
			// threshold (a group-key sig over the deposit digest) — no fund key, no mint.
			// Idempotent by deposit outpoint.
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.depositId !== "string" || typeof op.depositor !== "string") return;
			if (!attestationAuthorized(view, w, depositAttestationDigest({ depositId: op.depositId, depositor: op.depositor, amount: amt }), op.sig)) return;
			mintFromDeposit(view.bridge, { depositId: op.depositId, depositor: op.depositor, amount: amt }, bornHeight, custodyCeiling);
			return;
		}
		case "gbtc.transfer": {
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.to !== "string") return;
			transferGbtc(view.bridge, w.writer, op.to, amt, bornHeight);
			return;
		}
		case "bridge.withdraw": {
			// Burn gBTC → a pending BTC withdrawal. The BTC leaves only on bridge.settle
			// (after the threshold-signed payout tx confirms). `fee` (the withdrawer's chosen
			// miner fee) comes out of their own payout; requestWithdrawal enforces the floor.
			const amt = parseAmount(op.amount);
			const fee = parseAmount(op.fee);
			if (amt === null || fee === null || typeof op.btcAddress !== "string") return;
			// Vector B: gate against this epoch's remaining outflow allowance (undefined → uncapped).
			const available = withdrawBudget === undefined ? undefined : withdrawBudget - view.bridge.withdrawnTotal;
			requestWithdrawal(view.bridge, { id: w.id, owner: w.writer, amount: amt, btcAddress: op.btcAddress, fee }, available);
			return;
		}
		case "bridge.claim": {
			// A request to mint a verified deposit — the on-chain trigger. No authority:
			// it only ever credits the per-user-address owner, and the committee verifies
			// the deposit on-chain before minting, so a bogus claim mints nothing.
			if (typeof op.depositId !== "string" || typeof op.depositor !== "string") return;
			recordClaim(view.bridge, op.depositId, op.depositor, bornHeight);
			return;
		}
		case "bridge.broadcast": {
			// A withdrawal's payout txid → marks it in flight (committee stops re-signing).
			if (typeof op.withdrawalId !== "string" || typeof op.txid !== "string") return;
			recordBroadcast(view.bridge, op.withdrawalId, op.txid);
			return;
		}
		case "bridge.settle": {
			// Mark a withdrawal's BTC payout confirmed → reserves drop. Committee
			// threshold (group-key sig over the settle digest) only — no fund key, no settle.
			if (typeof op.withdrawalId !== "string") return;
			if (!attestationAuthorized(view, w, settleAttestationDigest({ withdrawalId: op.withdrawalId }), op.sig)) return;
			completeWithdrawal(view.bridge, op.withdrawalId);
			return;
		}
		case "market.report": {
			// A CHANNEL IS A MARKET: ANYONE may relay a SIGNED update; the fold verifies an M-of-N
			// quorum against the channel's trust anchor (Pyth's guardian set, or a generic signer
			// set) — so no relayer is trusted, and no single signer can forge. Newer publish-time
			// wins (monotonic, stored in `seq`); a forged or sub-quorum update simply fails.
			if (!market || typeof op.update !== "string") return;
			let r: { price: bigint; expo: number; publishTime: number } | null = null;
			if (market.kind === "pyth") {
				r = verifyPythUpdate(op.update).find((x) => x.feedId === market.feedId) ?? null;
			} else {
				// generic signer set — the update is JSON {price,expo,publishTime,set,sigs}.
				try {
					r = verifySignedQuorum(JSON.parse(op.update), market.signerSet);
				} catch {
					r = null; // malformed JSON → reject
				}
			}
			if (!r || r.price <= 0n) return; // unverified / wrong feed/source / non-positive
			if (r.publishTime <= view.market.seq) return; // not newer
			view.market.price = r.price;
			view.market.expo = r.expo; // the source's scale (for display; the mark stays the integer)
			view.market.seq = r.publishTime; // monotonic guard = publish time (unix seconds)
			view.market.at = bornHeight; // certified height → deterministic staleness
			return;
		}
		case "custody.fund": {
			// First announce wins and is IMMUTABLE — the fund address is permanent, so a
			// later (or conflicting) announce can never move it. Every genesis committee
			// member posts the same key; whichever lands first sticks.
			if (view.custody.fundKey !== null) return;
			if (typeof op.groupKey !== "string" || !/^[0-9a-f]+$/.test(op.groupKey) || typeof op.epoch !== "number") return;
			view.custody.fundKey = op.groupKey;
			view.custody.epoch = op.epoch;
			return;
		}
		case "match.open": {
			// Take a maker's signed offer → escrow BOTH sides, open a bilateral matched
			// contract. The taker is the write's author; the contract id is the write id.
			// The fold re-verifies the maker's signature and that both peers can cover the
			// stake right now — a maker who ghosted (spent the funds) simply no-ops. This is
			// the zero-sum, protocol-is-never-counterparty path that can't deplete reserves.
			const fill = parseAmount(op.fill);
			// Entry = the channel's market mark, at the write's stable certified height so
			// expiry/staleness don't drift on replay.
			const m = mark(view, bornHeight);
			if (fill === null || m === null) return; // stale/unpriced market → no entry
			// The pot may subsidise the maker fee: it draws the SAME finalized budget the backstop uses,
			// so full and checkpoint-pruned nodes agree on how much the pot can cover.
			const subsidyBudget = backstopBudget - view.bridge.potEscrowTaken;
			applyMatch(view.bridge, view.book, w.writer, w.id, op.offer, fill, bornHeight, m, subsidyBudget);
			return;
		}
		case "match.pot": {
			// Open against the liquidity backstop: the pot takes the opposite side at the channel's
			// mark, staking from finalized pot capital. available = the finalized budget minus what
			// the pot has already drawn (deterministic; keeps the free pot ≥ 0).
			const fill = parseAmount(op.fill);
			const lev = parseAmount(op.leverage);
			const m = mark(view, bornHeight);
			if (fill === null || lev === null || m === null) return;
			if (op.side !== "long" && op.side !== "short") return;
			const available = backstopBudget - view.bridge.potEscrowTaken;
			applyMatchPot(view.bridge, view.book, w.writer, w.id, op.side as Side, fill, lev, bornHeight, m, available);
			return;
		}
		case "contract.settle": {
			// Permissionless close: split the 2·stake pot at the channel's mark per the directional
			// payoff. A directional swap — either side may close any time (up to the time-lock cap); the
			// loser can't dodge the mark by stalling (the winner just closes it).
			if (typeof op.contractId !== "string") return;
			const c = view.book.contracts.get(op.contractId);
			if (!c) return;
			const m = mark(view, bornHeight);
			if (m === null) return; // market gone dark → can't settle at a trustworthy price (auto-unwinds at expiry)
			applySettle(view.bridge, view.book, op.contractId, m, bornHeight);
			return;
		}
		case "custody.bond": {
			// Lock the writer's free gBTC as a committee bond (its selection weight, slashable).
			const amt = parseAmount(op.amount);
			if (amt !== null) bond(view.bridge, w.writer, amt);
			return;
		}
		case "custody.unbond": {
			// Begin releasing bonded gBTC. Matures at the request's CERTIFIED height +
			// UNBOND_DELAY (stable across replays); slashable until then.
			const amt = parseAmount(op.amount);
			if (amt !== null) requestUnbond(view.bridge, w.writer, amt, bornHeight);
			return;
		}
		case "custody.slash": {
			// Permissionless: verify the equivocation proof, then award the culprit's bond
			// to the submitter (a bounty). A forged/invalid proof is a no-op.
			const culprit = equivocationCulprit(op.a, op.b);
			if (culprit) slash(view.bridge, culprit, w.writer);
			return;
		}
	}
}

// ── leverage bounds (consensus constants) ────────────────────────
export const MAX_LEVERAGE = 5n;
/** Minimum leverage. 1× is a fully-collateralized coin flip with no upside over fees —
 *  pointless — so the floor is 2×. */
export const MIN_LEVERAGE = 2n;
export function leverageOk(l: bigint): boolean {
	return l >= MIN_LEVERAGE && l <= MAX_LEVERAGE;
}
