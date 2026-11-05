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
import type { AnchorChain } from "../consensus/chain.ts";
import type { Anchor } from "../consensus/anchor.ts";
import { emptyBridge, gbtcOf as bridgeGbtcOf, totalGbtc, pendingTotal, mintFromDeposit, transferGbtc, requestWithdrawal, completeWithdrawal, recordClaim, recordBroadcast, pruneStaleClaims, settleIdleFee } from "../custody/bridge.ts";
import type { BridgeState } from "../custody/bridge.ts";
import { equivocationCulprit } from "../custody/fault-proof.ts";
import { verify as verifyThreshold } from "../custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest } from "../custody/attestation.ts";
import { fromHex } from "../det/canonical.ts";

export interface CustodyState {
	/** The threshold-custody fund's group key (hex), or null until genesis announces it.
	 *  The Taproot deposit address derives from this; it is permanent (set once). */
	fundKey: string | null;
	/** The epoch the fund was established in (−1 until announced). */
	epoch: number;
	/** Committee producers with a PROVEN fault (custody.fault) → the height the fault was recorded.
	 *  Committee derivation skips them for every epoch whose boundary is past that height. Permanent. */
	excluded: Map<string, number>;
}

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
		custody: { fundKey: v.custody.fundKey, epoch: v.custody.epoch, excluded: new Map(v.custody.excluded) },
	};
	return out;
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = opts.base
		? cloneView(opts.base) // deep copy so the cached/snapshot base isn't mutated
		: { bridge: emptyBridge(), custody: { fundKey: null, epoch: -1, excluded: new Map() } };
	const nowHeight = opts.nowHeight ?? 0;
	for (const w of [...writes].sort(cmp)) {
		const op = w.payload as Op | null;
		// Effects timed by height (credit clocks, claim/fault heights) use the write's STABLE
		// certifying height (bornAt) so they don't drift as the global nowHeight advances.
		if (isOp(op)) applyOp(view, w, op, opts.bornAt?.get(w.id) ?? nowHeight, opts.isRecentProducer);
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
	const { included, order, bornAt, nowHeight, chain } = finalizedOrdering(writes, anchors, k);
	if (nowHeight === null) return computeView([], { base });
	return computeView(included, { order, nowHeight, bornAt, base, isRecentProducer: faultLookback === undefined ? undefined : producedWithin(chain, faultLookback) });
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
	const anchor = anchors.get(anchorId);
	const { included, order, bornAt, nowHeight, chain } = orderingFor(writes, anchors, anchor ?? null);
	if (nowHeight === null) return computeView([], { base });
	return computeView(included, { order, nowHeight, bornAt, base, isRecentProducer: faultLookback === undefined ? undefined : producedWithin(chain, faultLookback) });
}

function applyOp(view: View, w: Write, op: Op, bornHeight: number, isRecentProducer?: (id: string, height: number) => boolean): void {
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
			// First announce wins and is IMMUTABLE — the fund address is permanent, so a
			// later (or conflicting) announce can never move it. Every genesis committee
			// member posts the same key; whichever lands first sticks.
			if (view.custody.fundKey !== null) return;
			if (typeof op.groupKey !== "string" || !/^[0-9a-f]+$/.test(op.groupKey) || typeof op.epoch !== "number") return;
			view.custody.fundKey = op.groupKey;
			view.custody.epoch = op.epoch;
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
