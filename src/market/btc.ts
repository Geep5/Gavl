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
 * Oracle = DECENTRALIZED median, no special node. Every node posts its OWN signed
 * `oracle.post` reading; the fold takes the MEDIAN of recent posters as the mark.
 * Each node still folds the same on-chain posts → the same median (deterministic);
 * what's banned is each node using its *own* live fetch as the mark (that diverges).
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "./ops.ts";
import { isOp } from "./ops.ts";
import { finalizedOrdering, orderingFor } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";
import { oraclePubHex, bridgePubHex } from "./oracle.ts";
import { emptyBridge, gbtcOf as bridgeGbtcOf, addGbtc, totalGbtc, bondedTotal, pendingTotal, mintFromDeposit, transferGbtc, requestWithdrawal, completeWithdrawal, recordClaim, recordBroadcast, bond, requestUnbond, releaseMatured, slash, pruneStaleClaims, DEMURRAGE_DAY, DEMURRAGE_GRACE_DAYS, DEMURRAGE_CUTOFF_DAYS, DEMURRAGE_KEEP_NUM, DEMURRAGE_KEEP_DEN, DEMURRAGE_DUST } from "../custody/bridge.ts";
import type { BridgeState } from "../custody/bridge.ts";
import { equivocationCulprit } from "../custody/slashing.ts";
import { emptyBook, escrowedInContracts, applyMatch, applyMatchPot, applySettle, pruneExpiredOffers, settleExpired } from "./intent.ts";
import type { Side } from "./intent.ts";
import type { MarketBook, Offer } from "./intent.ts";
import { serializeView, deserializeView } from "./state.ts";
import { verify as verifyThreshold } from "../custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest } from "../custody/attestation.ts";
import { fromHex } from "../det/canonical.ts";

// ── consensus constants (every node must agree) ──────────────────

/** The default dev oracle pubkey. No longer an authority — the oracle is now a median of
 *  all posters — but kept as a convenient default poster identity (and for back-compat).
 *  Override the seed via GAVL_ORACLE_SEED. */
export const BTC_ORACLE = oraclePubHex(process.env.GAVL_ORACLE_SEED);

/** The BTC bridge attestor (committee) key. Only it may mint gBTC from a verified
 *  deposit or settle a withdrawal. v0 single signer; production = threshold committee. */
export const BRIDGE_ATTESTOR = bridgePubHex(process.env.GAVL_BRIDGE_SEED);

export interface OracleReading {
	price: bigint;
	seq: number; // per-poster monotonic (replay/ordering guard)
	at: number; // global post index when folded (drives the recency window)
}

export interface OracleState {
	/** The mark = MEDIAN of recent posters' latest readings; null until anyone posts. No
	 *  single authority — every node posts its own reading and the median is the consensus. */
	price: bigint | null;
	/** Latest signed reading per poster (pubkey hex → reading). */
	readings: Map<string, OracleReading>;
	/** Count of oracle.post writes folded — a poster older than ORACLE_WINDOW posts is stale. */
	postCount: number;
	/** Disclosed methodology (latest from any poster) — transparency/audit, not authority. */
	sources: { endpoint: string; key: string }[];
}

/** How many recent posts define "fresh": a poster whose latest reading is older than this
 *  many folded posts drops out of the median, so departed/stale oracles stop counting. */
export const ORACLE_WINDOW = 64;


/** Drop readings that have fallen out of the freshness window — they no longer count toward
 *  the median, so this is behaviorally neutral, but it stops `readings` growing with every
 *  poster ever seen (a departed/rotated oracle's last reading lingered forever otherwise). */
function evictStaleReadings(o: OracleState): void {
	for (const [poster, r] of o.readings) if (o.postCount - r.at >= ORACLE_WINDOW) o.readings.delete(poster);
}

/** The median of the fresh posters' latest readings (even count → lower-mid average). */
function medianMark(o: OracleState): bigint | null {
	const fresh: bigint[] = [];
	for (const r of o.readings.values()) if (o.postCount - r.at < ORACLE_WINDOW) fresh.push(r.price);
	if (fresh.length === 0) return null;
	fresh.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const mid = fresh.length >> 1;
	return fresh.length % 2 === 1 ? fresh[mid] : (fresh[mid - 1] + fresh[mid]) / 2n;
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
	oracle: OracleState;
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
 * write's author is irrelevant then (anyone may relay a committee-signed attestation).
 * Before any committee fund exists (seed/testnet mode), it falls back to the single
 * legacy attestor key.
 */
function attestationAuthorized(view: View, w: Write, digest: Uint8Array, sig: string | undefined): boolean {
	if (view.custody.fundKey) {
		if (typeof sig !== "string") return false;
		try {
			return verifyThreshold(fromHex(sig), digest, fromHex(view.custody.fundKey));
		} catch {
			return false; // malformed sig/key → unauthorized
		}
	}
	return w.writer === BRIDGE_ATTESTOR; // legacy single attestor (no committee fund yet)
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
}

/**
 * Demurrage — a disclosed holding fee on IDLE (free) gBTC, swept into the liquidity POT. Per
 * balance, from its idle clock `chargeFrom` (= last-credit + grace):
 *   - before chargeFrom: untouched (the ~1-week grace),
 *   - after: −20%/day,
 *   - at the 1-month cutoff (or once it dips below the dust floor): take whatever's left.
 * The whole lifecycle is ≤ 1 month for ANY balance — the % decay is the gentle warning, the
 * cutoff the hard guarantee. The drag goes to `bridge.pot` (a conservation bucket), NOT
 * redistributed per-fold: redistribution to the active-contract set is path-dependent (which
 * contracts are open at a fold differs by checkpoint base → divergent appRoot → fork). The pot
 * is just a counter, so it's base-independent (= cumulative idle decay). It only MOVES gBTC
 * (idle → pot), never mints/burns, so 1:1 backing holds. The pot funds maker rebates / a
 * liquidity backstop at deterministic write events (a separate step).
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

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = opts.base
		? deserializeView(serializeView(opts.base)) // deep copy so the cached/snapshot base isn't mutated
		: {
				bridge: emptyBridge(),
				oracle: { price: null, readings: new Map(), postCount: 0, sources: [] },
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
	for (const w of [...writes].sort(cmp)) {
		const op = w.payload as Op | null;
		// Effects timed by height (unbond maturity) use the write's STABLE certifying
		// height (bornAt) so they don't drift as the global nowHeight advances; others
		// use nowHeight (the current anchor clock).
		if (isOp(op)) applyOp(view, w, op, nowHeight, opts.bornAt?.get(w.id) ?? nowHeight, backstopBudget);
	}
	releaseMatured(view.bridge, nowHeight); // matured unbonds → free gBTC (on the anchor clock)
	settleExpired(view.bridge, view.book, nowHeight); // time-locked perps unwind at entry (base-independent)
	accrueDemurrage(view, nowHeight); // idle gBTC bleeds to capital working in open contracts
	evictStaleReadings(view.oracle); // drop posters that fell out of the freshness window
	pruneExpiredOffers(view.book, nowHeight); // drop fill-tracking for offers that can no longer be matched
	pruneStaleClaims(view.bridge, nowHeight); // retire deposit-mint requests unminted past the reclaim grace
	return view;
}

/** Mark price for an instrument = the oracle price (or null until first post). */
export function mark(view: View): bigint | null {
	return view.oracle.price;
}

/**
 * Finality-bound view: fold only what the anchor `k` deep certifies, in the
 * PoST-bound order. Composes the pure consensus ordering with this app fold —
 * consensus never imports app state; the app calls consensus.
 */
export function finalizedView(writes: Write[], anchors: AnchorChain, k: number, base?: View): View {
	const { included, order, bornAt, nowHeight } = finalizedOrdering(writes, anchors, k);
	if (nowHeight === null) return base ? computeView([], { base }) : computeView([]);
	return computeView(included, { order, nowHeight, bornAt, base });
}

/**
 * The application state a SPECIFIC anchor commits to — the deterministic view of
 * exactly the writes its heads certify, in the chain-induced order. This is what an
 * anchor's `appRoot` is `viewRoot()` of; the producer computes it when mining and a
 * verifier recomputes it to accept the anchor. Optionally resumes from a checkpoint
 * `base` (a pruned node folds forward from its snapshot instead of from genesis).
 */
export function viewAtAnchor(writes: Write[], anchors: AnchorChain, anchorId: string, base?: View): View {
	const anchor = anchors.get(anchorId);
	const { included, order, bornAt, nowHeight } = orderingFor(writes, anchors, anchor ?? null);
	if (nowHeight === null) return base ? computeView([], { base }) : computeView([]);
	return computeView(included, { order, nowHeight, bornAt, base });
}

function applyOp(view: View, w: Write, op: Op, nowHeight: number, bornHeight: number, backstopBudget = 0n): void {
	switch (op.kind) {
		case "bridge.deposit": {
			// Mint gBTC 1:1 from a VERIFIED BTC deposit. Authorized by the committee
			// threshold (a group-key sig over the deposit digest) once a committee fund
			// exists, else the legacy single attestor key. Idempotent by deposit outpoint.
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.depositId !== "string" || typeof op.depositor !== "string") return;
			if (!attestationAuthorized(view, w, depositAttestationDigest({ depositId: op.depositId, depositor: op.depositor, amount: amt }), op.sig)) return;
			mintFromDeposit(view.bridge, { depositId: op.depositId, depositor: op.depositor, amount: amt }, bornHeight);
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
			// (after the threshold-signed payout tx confirms).
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.btcAddress !== "string") return;
			requestWithdrawal(view.bridge, { id: w.id, owner: w.writer, amount: amt, btcAddress: op.btcAddress });
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
			// threshold (group-key sig over the settle digest) once a fund exists, else
			// the legacy attestor key.
			if (typeof op.withdrawalId !== "string") return;
			if (!attestationAuthorized(view, w, settleAttestationDigest({ withdrawalId: op.withdrawalId }), op.sig)) return;
			completeWithdrawal(view.bridge, op.withdrawalId);
			return;
		}
		case "oracle.post": {
			// ANY node posts its OWN reading (poster = the writer). Per-poster monotonic seq
			// guards replay; the mark is the MEDIAN of recent posters — no single authority.
			const price = parseAmount(op.price);
			if (price === null || typeof op.seq !== "number") return;
			const prev = view.oracle.readings.get(w.writer);
			if (prev && op.seq <= prev.seq) return; // stale/replayed from this poster
			view.oracle.postCount++;
			view.oracle.readings.set(w.writer, { price, seq: op.seq, at: view.oracle.postCount });
			view.oracle.price = medianMark(view.oracle);
			return;
		}
		case "oracle.meta": {
			// Any poster discloses its sources on-chain (latest-wins) — transparency, not authority.
			if (!Array.isArray(op.sources)) return;
			view.oracle.sources = op.sources.filter((s) => s && typeof s.endpoint === "string" && typeof s.key === "string").map((s) => ({ endpoint: s.endpoint, key: s.key }));
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
			const m = mark(view);
			if (fill === null || m === null) return; // need an oracle mark for the entry price
			// Timing uses the write's STABLE certified height (bornHeight), like unbond — so
			// offer expiry / settle-window don't drift as the global tip advances on replay.
			// Entry = the current oracle mark.
			applyMatch(view.bridge, view.book, w.writer, w.id, op.offer, fill, bornHeight, m);
			return;
		}
		case "match.pot": {
			// Open against the liquidity backstop: the pot takes the opposite side at the mark,
			// staking from finalized pot capital. available = the finalized budget minus what the
			// pot has already drawn (deterministic; keeps the free pot ≥ 0). Entry = the mark.
			const fill = parseAmount(op.fill);
			const lev = parseAmount(op.leverage);
			const m = mark(view);
			if (fill === null || lev === null || m === null) return;
			if (op.side !== "long" && op.side !== "short") return;
			const available = backstopBudget - view.bridge.potEscrowTaken;
			applyMatchPot(view.bridge, view.book, w.writer, w.id, op.side as Side, fill, lev, bornHeight, m, available);
			return;
		}
		case "contract.settle": {
			// Permissionless close: split the 2·stake pot at the current oracle mark per the
			// directional payoff. Perpetual — either side may close any time; the loser can't
			// dodge the mark by stalling (the winner just closes it).
			const m = mark(view);
			if (m === null || typeof op.contractId !== "string") return;
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
