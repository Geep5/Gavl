/**
 * Deterministic serialization + commitment for the application View.
 *
 * The View ([market/btc.ts]) is held in RAM with `Map`/`Set`/`bigint` — none of
 * which `canonicalize` (plain-JSON only) can encode. To let an anchor COMMIT to the
 * folded state (so a finalized anchor becomes a trustless checkpoint), we need a
 * byte-for-byte deterministic encoding of the View:
 *
 *   serializeView(view) -> CanonState   (plain JSON: Maps→sorted [k,v]; Sets→sorted; bigint→decimal)
 *   viewRoot(view)      -> sha256Hex(canonicalize(CanonState))
 *   deserializeView(s)  -> View          (exact inverse — loads a snapshot back into RAM)
 *
 * CONSENSUS-CRITICAL: every node must compute the SAME root for the SAME logical
 * state, regardless of Map insertion order. All map/set encodings are key-sorted;
 * arrays whose order is itself state (pending withdrawals FIFO)
 * are kept in fold order. Round-trips are tested to be lossless.
 */

import { sha256Hex, canonicalize } from "../det/canonical.ts";
import type { View } from "./btc.ts";
import { emptyBridge } from "../custody/bridge.ts";
import type { BridgeState, PendingWithdrawal } from "../custody/bridge.ts";

// ── canonical (plain-JSON) shape ─────────────────────────────────

type Entry<V> = [string, V];

export interface CanonBridge {
	gbtc: Entry<string>[]; // pubkey → sats (decimal), sorted by pubkey
	reserves: string;
	processed: string[]; // sorted
	pending: { id: string; owner: string; amount: string; btcAddress: string; fee: string }[]; // fold order (FIFO)
	depositors: string[]; // sorted
	claims: Entry<{ depositor: string; height: number }>[]; // depositId → {depositor, request height}, sorted
	broadcasts: Entry<string>[]; // withdrawalId → txid, sorted
	mintedTotal: string;
	paidOut: string;
	chargeFrom: Entry<{ since: number; from: number; base: string; days: number }>[]; // pubkey → demurrage idle clock, sorted
	pot: string; // the liquidity pot (idle-fee bucket)
}

/** Plain-JSON custody state: the fund key/epoch plus the excluded (faulted) producers. */
export interface CanonCustody {
	fundKey: string | null;
	epoch: number;
	excluded: Entry<number>[]; // producer → fault height, sorted
}

export interface CanonState {
	bridge: CanonBridge;
	custody: CanonCustody;
}

// ── helpers ──────────────────────────────────────────────────────

const byKey = (a: Entry<unknown>, b: Entry<unknown>): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function mapEntries<V, W>(m: Map<string, V>, f: (v: V) => W): Entry<W>[] {
	const out: Entry<W>[] = [];
	for (const [k, v] of m) out.push([k, f(v)]);
	out.sort(byKey);
	return out;
}

function sortedSet(s: Set<string>): string[] {
	return [...s].sort();
}

// ── serialize ────────────────────────────────────────────────────

function serializeBridge(b: BridgeState): CanonBridge {
	return {
		gbtc: mapEntries(b.gbtc, (v) => v.toString()),
		reserves: b.reserves.toString(),
		processed: sortedSet(b.processed),
		pending: b.pending.map((p) => ({ id: p.id, owner: p.owner, amount: p.amount.toString(), btcAddress: p.btcAddress, fee: p.fee.toString() })),
		depositors: sortedSet(b.depositors),
		claims: mapEntries(b.claims, (c) => ({ depositor: c.depositor, height: c.height })),
		broadcasts: mapEntries(b.broadcasts, (v) => v),
		mintedTotal: b.mintedTotal.toString(),
		paidOut: b.paidOut.toString(),
		chargeFrom: mapEntries(b.chargeFrom, (e) => ({ since: e.since, from: e.from, base: e.base.toString(), days: e.days })),
		pot: b.pot.toString(),
	};
}

export function serializeView(view: View): CanonState {
	return {
		bridge: serializeBridge(view.bridge),
		custody: { fundKey: view.custody.fundKey, epoch: view.custody.epoch, excluded: mapEntries(view.custody.excluded, (h) => h) },
	};
}

/** The application-state commitment: a single hash over the whole folded View. */
export function viewRoot(view: View): string {
	return sha256Hex(canonicalize(serializeView(view)));
}

// ── deserialize (exact inverse) ──────────────────────────────────

function deserializeBridge(b: CanonBridge): BridgeState {
	const s = emptyBridge();
	for (const [k, v] of b.gbtc) s.gbtc.set(k, BigInt(v));
	s.reserves = BigInt(b.reserves);
	for (const id of b.processed) s.processed.add(id);
	s.pending = b.pending.map((p): PendingWithdrawal => ({ id: p.id, owner: p.owner, amount: BigInt(p.amount), btcAddress: p.btcAddress, fee: BigInt(p.fee ?? "1000") }));
	for (const d of b.depositors) s.depositors.add(d);
	for (const [k, c] of b.claims) s.claims.set(k, { depositor: c.depositor, height: c.height });
	for (const [k, v] of b.broadcasts) s.broadcasts.set(k, v);
	s.mintedTotal = BigInt(b.mintedTotal);
	s.paidOut = BigInt(b.paidOut);
	for (const [k, e] of b.chargeFrom) s.chargeFrom.set(k, { since: e.since, from: e.from, base: BigInt(e.base), days: e.days });
	s.pot = BigInt(b.pot);
	return s;
}

export function deserializeView(s: CanonState): View {
	return {
		bridge: deserializeBridge(s.bridge),
		custody: { fundKey: s.custody.fundKey, epoch: s.custody.epoch, excluded: new Map(s.custody.excluded) },
	};
}
