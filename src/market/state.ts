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
 * arrays whose order is itself state (pending withdrawals FIFO, disclosed sources)
 * are kept in fold order. Round-trips are tested to be lossless.
 */

import { sha256Hex, canonicalize } from "../det/canonical.ts";
import type { View } from "./btc.ts";
import { emptyBridge } from "../custody/bridge.ts";
import type { BridgeState, PendingWithdrawal } from "../custody/bridge.ts";
import type { MarketPrice, CustodyState } from "./btc.ts";
import { emptyBook } from "./intent.ts";
import type { MarketBook, Contract } from "./intent.ts";

// ── canonical (plain-JSON) shape ─────────────────────────────────

type Entry<V> = [string, V];

export interface CanonBridge {
	gbtc: Entry<string>[]; // pubkey → sats (decimal), sorted by pubkey
	reserves: string;
	processed: string[]; // sorted
	pending: { id: string; owner: string; amount: string; btcAddress: string }[]; // fold order (FIFO)
	depositors: string[]; // sorted
	claims: Entry<{ depositor: string; height: number }>[]; // depositId → {depositor, request height}, sorted
	broadcasts: Entry<string>[]; // withdrawalId → txid, sorted
	bonds: Entry<string>[]; // pubkey → sats, sorted
	unbonding: Entry<{ amount: string; releaseHeight: number }>[]; // pubkey → ..., sorted
	mintedTotal: string;
	paidOut: string;
	chargeFrom: Entry<{ since: number; charged: number }>[]; // pubkey → demurrage idle clock, sorted
	pot: string; // the liquidity pot (idle-decay bucket), free/unescrowed
	potEscrowTaken: string; // lifetime pot capital staked as backstop (budget counter)
}

export type CanonMarket = { price: string | null; expo: number; seq: number; at: number };

export interface CanonBook {
	contracts: Entry<{ id: string; long: string; short: string; stake: string; entry: string; leverage: string; nonce: string; expiryHeight: number }>[]; // sorted by id
	offerFills: Entry<{ filled: string; expiryHeight: number }>[]; // nonce → {filled sats, expiry}, sorted
}

export interface CanonState {
	bridge: CanonBridge;
	market: CanonMarket; // the channel's single market price (source/reporter come from the channel name)
	custody: CustodyState; // already plain (string|null, number)
	book: CanonBook;
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
		pending: b.pending.map((p) => ({ id: p.id, owner: p.owner, amount: p.amount.toString(), btcAddress: p.btcAddress })),
		depositors: sortedSet(b.depositors),
		claims: mapEntries(b.claims, (c) => ({ depositor: c.depositor, height: c.height })),
		broadcasts: mapEntries(b.broadcasts, (v) => v),
		bonds: mapEntries(b.bonds, (v) => v.toString()),
		unbonding: mapEntries(b.unbonding, (u) => ({ amount: u.amount.toString(), releaseHeight: u.releaseHeight })),
		mintedTotal: b.mintedTotal.toString(),
		paidOut: b.paidOut.toString(),
		chargeFrom: mapEntries(b.chargeFrom, (e) => ({ since: e.since, charged: e.charged })),
		pot: b.pot.toString(),
		potEscrowTaken: b.potEscrowTaken.toString(),
	};
}

function serializeBook(book: MarketBook): CanonBook {
	return {
		contracts: mapEntries(book.contracts, (c) => ({ id: c.id, long: c.long, short: c.short, stake: c.stake.toString(), entry: c.entry.toString(), leverage: c.leverage.toString(), nonce: c.nonce, expiryHeight: c.expiryHeight })),
		offerFills: mapEntries(book.offerFills, (f) => ({ filled: f.filled.toString(), expiryHeight: f.expiryHeight })),
	};
}

export function serializeView(view: View): CanonState {
	return {
		bridge: serializeBridge(view.bridge),
		market: { price: view.market.price === null ? null : view.market.price.toString(), expo: view.market.expo, seq: view.market.seq, at: view.market.at },
		custody: { fundKey: view.custody.fundKey, epoch: view.custody.epoch },
		book: serializeBook(view.book),
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
	s.pending = b.pending.map((p): PendingWithdrawal => ({ id: p.id, owner: p.owner, amount: BigInt(p.amount), btcAddress: p.btcAddress }));
	for (const d of b.depositors) s.depositors.add(d);
	for (const [k, c] of b.claims) s.claims.set(k, { depositor: c.depositor, height: c.height });
	for (const [k, v] of b.broadcasts) s.broadcasts.set(k, v);
	for (const [k, v] of b.bonds) s.bonds.set(k, BigInt(v));
	for (const [k, u] of b.unbonding) s.unbonding.set(k, { amount: BigInt(u.amount), releaseHeight: u.releaseHeight });
	s.mintedTotal = BigInt(b.mintedTotal);
	s.paidOut = BigInt(b.paidOut);
	for (const [k, e] of b.chargeFrom) s.chargeFrom.set(k, { since: e.since, charged: e.charged });
	s.pot = BigInt(b.pot);
	s.potEscrowTaken = BigInt(b.potEscrowTaken);
	return s;
}

function deserializeMarket(m: CanonMarket): MarketPrice {
	return { price: m.price === null ? null : BigInt(m.price), expo: m.expo ?? 0, seq: m.seq, at: m.at };
}

function deserializeBook(b: CanonBook): MarketBook {
	const book = emptyBook();
	for (const [id, c] of b.contracts) book.contracts.set(id, { id: c.id, long: c.long, short: c.short, stake: BigInt(c.stake), entry: BigInt(c.entry), leverage: BigInt(c.leverage), nonce: c.nonce, expiryHeight: c.expiryHeight } as Contract);
	for (const [k, f] of b.offerFills) book.offerFills.set(k, { filled: BigInt(f.filled), expiryHeight: f.expiryHeight });
	return book;
}

export function deserializeView(s: CanonState): View {
	return {
		bridge: deserializeBridge(s.bridge),
		market: deserializeMarket(s.market),
		custody: { fundKey: s.custody.fundKey, epoch: s.custody.epoch },
		book: deserializeBook(s.book),
	};
}
