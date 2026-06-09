/**
 * The BTC bridge ledger (Phase 4) — deposit → mint gBTC, burn → withdraw BTC.
 *
 * gBTC is a 1:1 claim on real Bitcoin held in the threshold-custody fund. Depositing
 * BTC mints gBTC; burning gBTC redeems BTC. The whole point is a single invariant
 * that must hold at ALL times:
 *
 *     reserves  ==  gBTC outstanding  +  pending withdrawals
 *
 * i.e. every gBTC is backed by a satoshi in the fund. Mint only on a verified
 * deposit; on redeem the gBTC burns immediately but the BTC leaves only once the
 * withdrawal tx confirms — so burned-but-not-yet-paid coins live in `pending` and
 * stay counted as backed. Conservation is tested.
 *
 * TRUST BOUNDARY: this module mints on a VERIFIED deposit attestation. How a
 * deposit becomes "verified" — i.e. how the fold learns a BTC tx paid the fund —
 * is the bridge's trust input: either the custody committee threshold-signs an
 * attestation (honest-majority, same set that holds the key) or a user submits an
 * SPV/Merkle proof the fold checks (more trustless, needs Bitcoin headers). That
 * piece is separate; here a deposit is a verified fact.
 *
 * Pure (BigInt sats), deterministic, no Bitcoin imports — the actual payout tx is
 * built by composing `withdrawalPayouts()` with custody/btctx (see the test).
 */

export interface DepositAttestation {
	/** Unique deposit id — the funding Bitcoin outpoint `txid:vout`. Dedupes mints. */
	depositId: string;
	/** Gavl pubkey to credit the gBTC to. */
	depositor: string;
	/** Sats deposited (== gBTC minted). */
	amount: bigint;
}

export interface PendingWithdrawal {
	/** Unique id — the burn-write's id. */
	id: string;
	owner: string;
	amount: bigint; // sats of gBTC burned, owed as BTC
	btcAddress: string; // where to send the BTC
}

export interface BridgeState {
	gbtc: Map<string, bigint>; // pubkey → gBTC balance (sats)
	reserves: bigint; // BTC currently in the fund (sats)
	processed: Set<string>; // deposit ids already minted (idempotency)
	pending: PendingWithdrawal[]; // burned gBTC awaiting a BTC payout
	mintedTotal: bigint; // audit: lifetime minted
	paidOut: bigint; // audit: lifetime BTC paid out
}

export function emptyBridge(): BridgeState {
	return { gbtc: new Map(), reserves: 0n, processed: new Set(), pending: [], mintedTotal: 0n, paidOut: 0n };
}

export function gbtcOf(s: BridgeState, pubkey: string): bigint {
	return s.gbtc.get(pubkey) ?? 0n;
}
function addG(s: BridgeState, pubkey: string, v: bigint): void {
	const n = (s.gbtc.get(pubkey) ?? 0n) + v;
	if (n === 0n) s.gbtc.delete(pubkey);
	else s.gbtc.set(pubkey, n);
}
/** Low-level gBTC balance move (e.g. escrowing margin into the perp pool). Conserves
 *  total only if the caller balances it elsewhere (the pool holds the other side). */
export function addGbtc(s: BridgeState, pubkey: string, v: bigint): void {
	addG(s, pubkey, v);
}
export function totalGbtc(s: BridgeState): bigint {
	let t = 0n;
	for (const v of s.gbtc.values()) t += v;
	return t;
}
export function pendingTotal(s: BridgeState): bigint {
	let t = 0n;
	for (const w of s.pending) t += w.amount;
	return t;
}

/** The 1:1 backing invariant — reserves account for exactly the outstanding claims. */
export function conserved(s: BridgeState): boolean {
	return s.reserves === totalGbtc(s) + pendingTotal(s);
}
/** Backing ratio in bps (10000 = fully 1:1 backed). Always 10000 if the invariant holds. */
export function backingBps(s: BridgeState): bigint {
	const owed = totalGbtc(s) + pendingTotal(s);
	return owed === 0n ? 10_000n : (s.reserves * 10_000n) / owed;
}

// ── deposit → mint ───────────────────────────────────────────────

/**
 * Mint gBTC 1:1 from a VERIFIED deposit. Idempotent: a deposit id is minted at
 * most once (replays are no-ops), so an attestation can be gossiped freely.
 * Returns true if it minted.
 */
export function mintFromDeposit(s: BridgeState, att: DepositAttestation): boolean {
	if (att.amount <= 0n || s.processed.has(att.depositId)) return false;
	s.processed.add(att.depositId);
	s.reserves += att.amount; // BTC now in the fund
	addG(s, att.depositor, att.amount); // gBTC minted to the depositor
	s.mintedTotal += att.amount;
	return true;
}

// ── transfer (gBTC is the tradeable claim) ───────────────────────

export function transferGbtc(s: BridgeState, from: string, to: string, amount: bigint): boolean {
	if (amount <= 0n || gbtcOf(s, from) < amount) return false;
	addG(s, from, -amount);
	addG(s, to, amount);
	return true;
}

// ── burn → withdraw ──────────────────────────────────────────────

/**
 * Burn `amount` gBTC and record a pending BTC withdrawal to `btcAddress`. The gBTC
 * is destroyed now; the BTC stays in `reserves` (counted as `pending`) until the
 * payout tx confirms. No-op (returns false) if the owner can't cover it or the id
 * was already used.
 */
export function requestWithdrawal(s: BridgeState, w: PendingWithdrawal): boolean {
	if (w.amount <= 0n || gbtcOf(s, w.owner) < w.amount) return false;
	if (s.pending.some((p) => p.id === w.id)) return false;
	addG(s, w.owner, -w.amount); // burn gBTC
	s.pending.push({ ...w }); // now owed as BTC (still backed by reserves)
	return true;
}

/** The Bitcoin outputs needed to settle all pending withdrawals (feed to btctx). */
export function withdrawalPayouts(s: BridgeState): { address: string; amount: bigint }[] {
	return s.pending.map((w) => ({ address: w.btcAddress, amount: w.amount }));
}

/**
 * Mark a pending withdrawal settled once its BTC payout tx has confirmed: the BTC
 * actually leaves the fund now. reserves and pending both drop by the amount, so
 * the invariant is preserved. Returns true if it closed one.
 */
export function completeWithdrawal(s: BridgeState, id: string): boolean {
	const i = s.pending.findIndex((w) => w.id === id);
	if (i < 0) return false;
	const w = s.pending[i];
	s.reserves -= w.amount; // BTC has left the fund
	s.paidOut += w.amount;
	s.pending.splice(i, 1);
	return true;
}
