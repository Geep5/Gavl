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
 * Oracle authority = a hardcoded pubkey (BTC_ORACLE). Prices enter as signed
 * `oracle.post` writes folded by every node (monotonic seq) — never per-node
 * webhook fetches, which would diverge. Deterministic across the network.
 */

import type { Write } from "../chain/writer.ts";
import type { Op } from "./ops.ts";
import { isOp } from "./ops.ts";
import { finalizedOrdering } from "../consensus/order.ts";
import type { AnchorChain } from "../consensus/chain.ts";
import { oraclePubHex, bridgePubHex } from "./oracle.ts";
import { emptyBridge, gbtcOf as bridgeGbtcOf, addGbtc, totalGbtc, bondedTotal, pendingTotal, mintFromDeposit, transferGbtc, requestWithdrawal, completeWithdrawal, recordClaim, recordBroadcast, bond, requestUnbond, releaseMatured, slash } from "../custody/bridge.ts";
import type { BridgeState } from "../custody/bridge.ts";
import { equivocationCulprit } from "../custody/slashing.ts";
import { emptyBook, escrowedInContracts, applyMatch, applySettle } from "./intent.ts";
import type { MarketBook, Offer } from "./intent.ts";
import { verify as verifyThreshold } from "../custody/threshold.ts";
import { depositAttestationDigest, settleAttestationDigest } from "../custody/attestation.ts";
import { fromHex } from "../det/canonical.ts";

// ── consensus constants (every node must agree) ──────────────────

/** The single hardcoded BTC price oracle for v1 (its Ed25519 pubkey hex).
 *  Derived from a fixed seed (see oracle.ts) so the constant is a REAL key the
 *  publisher can sign with; generic so more oracles/instruments register later.
 *  Override the seed (and thus this) via GAVL_ORACLE_SEED for a real deployment. */
export const BTC_ORACLE = oraclePubHex(process.env.GAVL_ORACLE_SEED);

/** The BTC bridge attestor (committee) key. Only it may mint gBTC from a verified
 *  deposit or settle a withdrawal. v0 single signer; production = threshold committee. */
export const BRIDGE_ATTESTOR = bridgePubHex(process.env.GAVL_BRIDGE_SEED);

export interface OracleState {
	id: string;
	price: bigint | null; // latest finalized price, or null until first post
	seq: number; // monotonic; rejects stale/replayed posts
	/** The oracle's on-chain-disclosed methodology: the sources it derives the price
	 *  from. Visible to EVERY client (folded into state), not just the publisher. */
	sources: { endpoint: string; key: string }[];
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
 * contract, or burned-and-pending — is backed by a satoshi in reserves. Match/settle
 * only MOVE gBTC between these buckets, never mint, so this always holds.
 */
export function marketConserved(view: View): boolean {
	return view.bridge.reserves === totalGbtc(view.bridge) + bondedTotal(view.bridge) + escrowedInContracts(view.book) + pendingTotal(view.bridge);
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
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = {
		bridge: emptyBridge(),
		oracle: { id: BTC_ORACLE, price: null, seq: -1, sources: [] },
		custody: { fundKey: null, epoch: -1 },
		book: emptyBook(),
	};
	const nowHeight = opts.nowHeight ?? 0;
	for (const w of [...writes].sort(cmp)) {
		const op = w.payload as Op | null;
		// Effects timed by height (unbond maturity) use the write's STABLE certifying
		// height (bornAt) so they don't drift as the global nowHeight advances; others
		// use nowHeight (the current anchor clock).
		if (isOp(op)) applyOp(view, w, op, nowHeight, opts.bornAt?.get(w.id) ?? nowHeight);
	}
	releaseMatured(view.bridge, nowHeight); // matured unbonds → free gBTC (on the anchor clock)
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
export function finalizedView(writes: Write[], anchors: AnchorChain, k: number): View {
	const { included, order, bornAt, nowHeight } = finalizedOrdering(writes, anchors, k);
	if (nowHeight === null) return computeView([]);
	return computeView(included, { order, nowHeight, bornAt });
}

function applyOp(view: View, w: Write, op: Op, nowHeight: number, bornHeight: number): void {
	switch (op.kind) {
		case "bridge.deposit": {
			// Mint gBTC 1:1 from a VERIFIED BTC deposit. Authorized by the committee
			// threshold (a group-key sig over the deposit digest) once a committee fund
			// exists, else the legacy single attestor key. Idempotent by deposit outpoint.
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.depositId !== "string" || typeof op.depositor !== "string") return;
			if (!attestationAuthorized(view, w, depositAttestationDigest({ depositId: op.depositId, depositor: op.depositor, amount: amt }), op.sig)) return;
			mintFromDeposit(view.bridge, { depositId: op.depositId, depositor: op.depositor, amount: amt });
			return;
		}
		case "gbtc.transfer": {
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.to !== "string") return;
			transferGbtc(view.bridge, w.writer, op.to, amt);
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
			recordClaim(view.bridge, op.depositId, op.depositor);
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
			// Authority is the oracle KEY (= the writer must be the oracle), monotonic seq.
			if (op.oracle !== view.oracle.id) return;
			if (w.writer !== view.oracle.id) return; // only the oracle key may post
			if (typeof op.seq !== "number" || op.seq <= view.oracle.seq) return; // stale/replay
			const price = parseAmount(op.price);
			if (price === null) return;
			view.oracle.price = price;
			view.oracle.seq = op.seq;
			return;
		}
		case "oracle.meta": {
			// The oracle discloses its sources on-chain (latest-wins). Only the oracle key.
			if (op.oracle !== view.oracle.id || w.writer !== view.oracle.id) return;
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
		case "contract.settle": {
			// Permissionless close: split the 2·stake pot at the current oracle mark per the
			// directional payoff. Perpetual — either side may close any time; the loser can't
			// dodge the mark by stalling (the winner just closes it).
			const m = mark(view);
			if (m === null || typeof op.contractId !== "string") return;
			applySettle(view.bridge, view.book, op.contractId, m);
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
