/**
 * Gavl state — the gBTC ledger, a pure fold of the write set.
 *
 *   computeView(writes) -> { bridge, custody }
 *
 * gBTC is a 1:1 claim on real BTC held by threshold custody. The fold wires the bridge
 * (deposit/claim/withdraw/settle), transfers, committee fault records and the custody fund
 * announce. There is no price oracle: every op only MOVES gBTC between buckets, so reserves
 * always equal the gBTC they back.
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "./ops.ts";
import { isOp } from "./ops.ts";
import { finalizedOrdering, orderingFor } from "../consensus/order.ts";
import type { FinalOrdering } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";
import type { Anchor } from "../consensus/anchor.ts";
import { emptyBridge, gbtcOf as bridgeGbtcOf, totalGbtc, pendingTotal, mintFromDeposit, transferGbtc, requestWithdrawal, completeWithdrawal, recordClaim, recordBroadcast, pruneStaleClaims, settleIdleFee } from "../custody/bridge.ts";
import type { BridgeState } from "../custody/bridge.ts";
import { equivocationCulprit } from "../custody/fault-proof.ts";
import { verify as verifyThreshold } from "../custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest, handoffDigest } from "../custody/attestation.ts";
import { custodyCommittee, custodyParamsOf, epochBoundary } from "../custody/epoch.ts";
import type { AnchorView, CustodyParams, EpochCommittee } from "../custody/epoch.ts";
import { fromHex } from "../det/canonical.ts";

/** Who holds the fund key, as recorded on-chain: the committee (sorted ids) + its signing threshold,
 *  the epoch whose ceremony gave it its shares, and the certified height the record landed at. */
export interface CustodyHolder {
	epoch: number;
	committee: string[];
	min: number;
	since: number;
}

export interface CustodyState {
	/** The threshold-custody fund's group key (hex), or null until genesis announces it.
	 *  The Taproot deposit address derives from this; it is permanent (set once). */
	fundKey: string | null;
	/** The epoch the fund was established in (−1 until announced). */
	epoch: number;
	/** Committee producers with a PROVEN fault (custody.fault) → the height the fault was recorded.
	 *  Committee derivation skips them for every epoch whose boundary is past that height. Permanent. */
	excluded: Map<string, number>;
	/** The committee that currently holds the key: set by custody.fund (genesis), advanced only by a
	 *  group-key-signed custody.handoff. A failed reshare records nothing, so this stays the real holder. */
	holder: CustodyHolder | null;
	/** The holder before `holder` — kept so holderAt() can answer "who held it at a boundary" even when
	 *  the latest handoff landed after that boundary (see holderAt). */
	prevHolder: CustodyHolder | null;
	/** Genesis endorsements not yet unanimous: proposal (fundProposalKey) → sorted ids of the sampled
	 *  genesis committee members who posted it. Only real members can add entries; cleared once a
	 *  fund is established. */
	fundVotes: Map<string, string[]>;
}

/** The recorded holder as of anchor height `height`: the latest record certified strictly BELOW it.
 *  Every node reading the same finalized state gets the same answer for an epoch boundary, even if
 *  one handoff landed between the boundary and now. Null if none (pre-genesis, or the boundary
 *  precedes the genesis record). */
export function holderAt(custody: CustodyState, height: number): CustodyHolder | null {
	if (custody.holder && custody.holder.since < height) return custody.holder;
	if (custody.prevHolder && custody.prevHolder.since < height) return custody.prevHolder;
	return null;
}

/** A committee as posted on-chain: a non-empty, strictly sorted (so canonical + duplicate-free) id list
 *  with an integer threshold in [1, size]. */
function validCommittee(committee: unknown, min: unknown): committee is string[] {
	if (!Array.isArray(committee) || committee.length === 0 || typeof min !== "number" || !Number.isInteger(min) || min < 1 || min > committee.length) return false;
	for (let i = 0; i < committee.length; i++) if (typeof committee[i] !== "string" || (i > 0 && !(committee[i - 1] < committee[i]))) return false;
	return true;
}

const copyHolder = (h: CustodyHolder | null): CustodyHolder | null => (h ? { ...h, committee: [...h.committee] } : null);

/**
 * How the fold checks custody records against the chain that certifies them. `committeeAt` returns
 * THE custody committee for `epoch` (custodyCommittee over the certifying chain + the network's
 * CustodyParams), or null when the record can't be checked: a CERTIFIED fold requires the epoch's
 * boundary to sit strictly below the write's certified height, so a record's validity depends only
 * on history at that height — every fold path (full, checkpoint-resumed, any later anchor) agrees.
 * Without rules (an anchor-less fold) custody.fund / custody.handoff are no-ops.
 */
export interface CustodyRules {
	committeeAt(epoch: number, bornHeight: number, fundEpoch: number | null, excluded: ReadonlyMap<string, number>): EpochCommittee | null;
}

/** Rules over `chain` (oldest→newest). `certified`: enforce boundary < the write's certified height
 *  (finalized / per-anchor folds); false for the optimistic tip fold, whose writes aren't certified yet. */
export function custodyRules(chain: AnchorView[], params: CustodyParams, certified: boolean): CustodyRules {
	return {
		committeeAt: (epoch, bornHeight, fundEpoch, excluded) => {
			if (!Number.isInteger(epoch) || epoch < 1) return null;
			if (certified && epochBoundary(epoch, params.epochLength) >= bornHeight) return null;
			return custodyCommittee(chain, epoch, params, fundEpoch, excluded);
		},
	};
}

const fundProposalKey = (groupKey: string, epoch: number, committee: string[], min: number): string => `${groupKey}|${epoch}|${committee.join(",")}|${min}`;
const sameCommittee = (c: EpochCommittee, committee: string[], min: number): boolean => c.min === min && [...c.committee].sort().join(",") === committee.join(",");

export interface View {
	/** The BTC bridge: gBTC balances + BTC reserves + processed deposits + pending
	 *  withdrawals. gBTC is the collateral — a 1:1 claim on real Bitcoin in the fund. */
	bridge: BridgeState;
	/** The threshold-custody fund key, announced on-chain at genesis (committee mode). */
	custody: CustodyState;
}

/** Active gBTC balance of `pubkey`. */
export function gbtcOf(view: View, pubkey: string): bigint {
	return bridgeGbtcOf(view.bridge, pubkey);
}

/**
 * The 1:1 backing invariant: every gBTC — free, held in the liquidity pot, or burned-and-pending —
 * is backed by a satoshi in reserves. Transfers/demurrage only MOVE gBTC between these buckets,
 * never mint, so this always holds.
 */
export function marketConserved(view: View): boolean {
	return view.bridge.reserves === totalGbtc(view.bridge) + pendingTotal(view.bridge) + view.bridge.pot;
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
	/** Anchor-clock "now" — drives height-timed effects (demurrage, claim expiry). */
	nowHeight?: number;
	/** Per-write certifying-anchor height (from finalizedOrdering) — the STABLE height a
	 *  write happened at (credit clocks, claim/fault heights), which must not drift as the
	 *  fold's global `nowHeight` advances. */
	bornAt?: Map<string, number>;
	/** Resume from this state (a checkpoint): the fold starts from a DEEP COPY of `base`
	 *  and applies only `writes` on top. Folding [post-checkpoint writes] onto the
	 *  checkpoint view equals folding the full history — the basis for never replaying
	 *  from 0. Height-timed effects act on state carried in `base`. */
	base?: View;
	/** Fault-record gate: true iff `id` produced a certified anchor within the fault lookback ending
	 *  at `height` (the fault write's certified height). Built from the certifying chain by
	 *  finalizedView/viewAtAnchor; absent (an anchor-less optimistic fold) → custody.fault records
	 *  nothing, since the producer set can't be checked. */
	isRecentProducer?: (id: string, height: number) => boolean;
	/** Custody-record gate (custodyRules): built from the certifying chain by finalizedView /
	 *  viewAtAnchor; absent → custody.fund / custody.handoff record nothing. */
	custodyRules?: CustodyRules;
}

/** The fault-record gate over a certifying chain: did `id` produce an anchor at a height in
 *  [height − lookback, height]? Depends only on the write's certified height (never the fold's), so
 *  every fold path agrees. Evaluated lazily — only when a custody.fault is folded. */
export function producedWithin(chain: readonly Pick<Anchor, "height" | "producer">[], lookback: number): (id: string, height: number) => boolean {
	return (id, height) => {
		for (let i = chain.length - 1; i >= 0 && chain[i].height >= height - lookback; i--) if (chain[i].height <= height && chain[i].producer === id) return true;
		return false;
	};
}

/**
 * Demurrage — the RAM ledger's "balances can't sit idle forever" rule, turned into liquidity. Inside
 * the ~1-week grace nothing is charged; past it, an idle balance pays a gentle LINEAR fee of 1% per 30
 * days, per WHOLE elapsed day, into `bridge.pot`. The fee owed is a pure function of the balance's idle
 * clock and the height (see IdleClock), and every write that touches a balance settles it at its own
 * certified height first — so settling every balance again at the fold's end changes nothing about the
 * total: any split of the history into folds yields the same state. O(1) per balance. Only MOVES gBTC
 * (idle → pot), never mints/burns, so 1:1 backing holds. Nothing draws from the pot.
 */
function accrueDemurrage(view: View, nowHeight: number): void {
	for (const k of view.bridge.gbtc.keys()) settleIdleFee(view.bridge, k, nowHeight);
}

/**
 * Deep-copy a View so a resumed fold can mutate freely without touching the cached/snapshot base.
 * A direct structural clone — Maps/Sets rebuilt, every nested value object the fold mutates in
 * place (chargeFrom's `charged`, pending/claims) copied — instead of a
 * serialize→sort→stringify→parse round-trip. Same result, far cheaper. The resumable-fold and
 * checkpoint-equivalence tests (full fold vs base-resumed fold) guard that this copies everything
 * the serializer would: a dropped field would diverge the resumed viewRoot.
 */
export function cloneView(v: View): View {
	const b = v.bridge;
	const cp = <T extends object>(m: Map<string, T>): Map<string, T> => new Map([...m].map(([k, x]) => [k, { ...x }]));
	const out: View = {
		bridge: {
			gbtc: new Map(b.gbtc), // bigint values are immutable → shallow Map copy is a full copy
			reserves: b.reserves,
			processed: new Set(b.processed),
			pending: b.pending.map((p) => ({ ...p })),
			depositors: new Set(b.depositors),
			claims: cp(b.claims),
			broadcasts: new Map(b.broadcasts),
			mintedTotal: b.mintedTotal,
			paidOut: b.paidOut,
			chargeFrom: cp(b.chargeFrom),
			pot: b.pot,
		},
		custody: {
			fundKey: v.custody.fundKey,
			epoch: v.custody.epoch,
			excluded: new Map(v.custody.excluded),
			holder: copyHolder(v.custody.holder),
			prevHolder: copyHolder(v.custody.prevHolder),
			fundVotes: new Map([...v.custody.fundVotes].map(([k, ids]) => [k, [...ids]])),
		},
	};
	return out;
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = opts.base
		? cloneView(opts.base) // deep copy so the cached/snapshot base isn't mutated
		: { bridge: emptyBridge(), custody: { fundKey: null, epoch: -1, excluded: new Map(), holder: null, prevHolder: null, fundVotes: new Map() } };
	const nowHeight = opts.nowHeight ?? 0;
	for (const w of [...writes].sort(cmp)) {
		const op = w.payload as Op | null;
		// Effects timed by height (credit clocks, claim/fault heights) use the write's STABLE
		// certifying height (bornAt) so they don't drift as the global nowHeight advances.
		if (isOp(op)) applyOp(view, w, op, opts.bornAt?.get(w.id) ?? nowHeight, opts.isRecentProducer, opts.custodyRules);
	}
	accrueDemurrage(view, nowHeight); // idle gBTC pays a linear fee into the liquidity pot
	pruneStaleClaims(view.bridge, nowHeight); // retire deposit-mint requests unminted past the reclaim grace
	return view;
}

/**
 * Finality-bound view: fold only what the anchor `k` deep certifies, in the
 * PoST-bound order. Composes the pure consensus ordering with this app fold —
 * consensus never imports app state; the app calls consensus. `faultLookback` (anchors) scopes
 * which producers a custody.fault may exclude; omitted → faults record nothing. Consensus-critical:
 * every node must pass the same value.
 */
export function finalizedView(writes: Write[], anchors: AnchorChain, k: number, base?: View, faultLookback?: number): View {
	return foldOrdering(finalizedOrdering(writes, anchors, k), anchors, base, faultLookback);
}

/**
 * The application state a SPECIFIC anchor commits to — the deterministic view of
 * exactly the writes its heads certify, in the chain-induced order. This is what an
 * anchor's `appRoot` is `viewRoot()` of; the producer computes it when mining and a
 * verifier recomputes it to accept the anchor. Optionally resumes from a checkpoint
 * `base` (a pruned node folds forward from its snapshot instead of from genesis).
 * `faultLookback` as in finalizedView.
 */
export function viewAtAnchor(writes: Write[], anchors: AnchorChain, anchorId: string, base?: View, faultLookback?: number): View {
	return foldOrdering(orderingFor(writes, anchors, anchors.get(anchorId) ?? null), anchors, base, faultLookback);
}

/** Fold a certified ordering with the gates its certifying chain provides: the fault-record producer
 *  check and the custody-record committee check (the network's CustodyParams ride on ChainParams). */
function foldOrdering(o: FinalOrdering, anchors: AnchorChain, base?: View, faultLookback?: number): View {
	if (o.nowHeight === null) return computeView([], { base });
	return computeView(o.included, {
		order: o.order,
		nowHeight: o.nowHeight,
		bornAt: o.bornAt,
		base,
		isRecentProducer: faultLookback === undefined ? undefined : producedWithin(o.chain, faultLookback),
		custodyRules: custodyRules(o.chain, custodyParamsOf(anchors.params), true),
	});
}

function applyOp(view: View, w: Write, op: Op, bornHeight: number, isRecentProducer?: (id: string, height: number) => boolean, rules?: CustodyRules): void {
	switch (op.kind) {
		case "bridge.deposit": {
			// Mint gBTC 1:1 from a VERIFIED BTC deposit. Authorized ONLY by the committee
			// threshold (a group-key sig over the deposit digest) — no fund key, no mint.
			// Idempotent by deposit outpoint.
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
			// (after the threshold-signed payout tx confirms). `fee` (the withdrawer's chosen
			// miner fee) comes out of their own payout; requestWithdrawal enforces the floor.
			const amt = parseAmount(op.amount);
			const fee = parseAmount(op.fee);
			if (amt === null || fee === null || typeof op.btcAddress !== "string") return;
			requestWithdrawal(view.bridge, { id: w.id, owner: w.writer, amount: amt, btcAddress: op.btcAddress, fee }, bornHeight);
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
		case "custody.fund": {
			// GENESIS: the fund key + first holder. Valid only as a UNANIMOUS endorsement by THE sampled
			// genesis committee for `epoch` (derived here from the certifying chain): each member posts
			// the identical proposal from its producer key — the write's Ed25519 signature IS the
			// endorsement, so the writer must be a member. The proposal takes effect once every member
			// has posted it (the DKG is n-of-n, so all of them hold the key). A stranger's key, a
			// non-sampled committee, or a missing member never establishes a fund. First complete
			// proposal wins and is IMMUTABLE — the fund address is permanent.
			if (view.custody.fundKey !== null || !rules) return;
			if (typeof op.groupKey !== "string" || !/^[0-9a-f]+$/.test(op.groupKey) || !validCommittee(op.committee, op.min)) return;
			const c = rules.committeeAt(op.epoch, bornHeight, null, view.custody.excluded);
			if (!c || !sameCommittee(c, op.committee, op.min) || !op.committee.includes(w.writer)) return;
			const key = fundProposalKey(op.groupKey, op.epoch, op.committee, op.min);
			// One live vote per member: a newer proposal from the same member withdraws its earlier one,
			// so pending votes stay bounded by the number of distinct members (no unbounded growth).
			for (const [k, ids] of view.custody.fundVotes) {
				if (k === key || !ids.includes(w.writer)) continue;
				const rest = ids.filter((id) => id !== w.writer);
				if (rest.length === 0) view.custody.fundVotes.delete(k);
				else view.custody.fundVotes.set(k, rest);
			}
			const votes = new Set(view.custody.fundVotes.get(key) ?? []).add(w.writer);
			if (votes.size < op.committee.length) {
				view.custody.fundVotes.set(key, [...votes].sort());
				return;
			}
			view.custody.fundKey = op.groupKey;
			view.custody.epoch = op.epoch;
			view.custody.holder = { epoch: op.epoch, committee: [...op.committee], min: op.min, since: bornHeight };
			view.custody.fundVotes.clear(); // decided — losing proposals are dead
			return;
		}
		case "custody.handoff": {
			// A reshare completed: the NEW committee proved it holds the key by threshold-signing the
			// record with its new shares (BIP340 under the fund key, like an attestation), and it must be
			// THE sampled committee for that epoch (derived here from the certifying chain). Only a LATER
			// epoch than the current holder's advances it; a stale / replayed / forged record is a no-op.
			const cur = view.custody.holder;
			if (!rules || !cur || view.custody.fundKey === null || !Number.isInteger(op.epoch) || op.epoch <= cur.epoch || !validCommittee(op.committee, op.min) || typeof op.sig !== "string") return;
			const c = rules.committeeAt(op.epoch, bornHeight, view.custody.epoch, view.custody.excluded);
			if (!c || !sameCommittee(c, op.committee, op.min)) return;
			let ok = false;
			try {
				ok = verifyThreshold(fromHex(op.sig), handoffDigest({ groupKey: view.custody.fundKey, epoch: op.epoch, committee: op.committee, min: op.min }), fromHex(view.custody.fundKey));
			} catch {
				ok = false; // malformed sig → unauthorized
			}
			if (!ok) return;
			view.custody.prevHolder = cur;
			view.custody.holder = { epoch: op.epoch, committee: [...op.committee], min: op.min, since: bornHeight };
			return;
		}
		case "custody.fault": {
			// Permissionless: verify the equivocation proof IN-FOLD, then record the culprit as
			// excluded from every committee whose epoch boundary lies past this (certified) height.
			// Only a culprit that PRODUCED a certified anchor within the fault lookback is recorded —
			// throwaway keys can't grow the excluded set. First record wins (the earliest height).
			// A forged/invalid proof, or no producer gate (anchor-less fold), is a no-op.
			const culprit = equivocationCulprit(op.a, op.b);
			if (culprit && !view.custody.excluded.has(culprit) && isRecentProducer?.(culprit, bornHeight)) view.custody.excluded.set(culprit, bornHeight);
			return;
		}
	}
}
