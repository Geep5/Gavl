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
	/** Every pubkey that has ever deposited — its per-user deposit address may hold
	 *  fund BTC, so reserves + withdrawals scan these. */
	depositors: Set<string>;
	/** Deposit-mint REQUESTS (depositId → depositor) — the on-chain trigger that tells
	 *  every committee member to verify this deposit on-chain and co-sign the mint. A
	 *  request whose depositId is already `processed` is satisfied. */
	claims: Map<string, string>;
	/** Withdrawal payout txids (withdrawalId → btc txid) — posted once the committee has
	 *  signed + broadcast the payout. Marks a withdrawal IN FLIGHT so members stop
	 *  re-signing it and instead watch that txid for confirmation, then co-sign settle. */
	broadcasts: Map<string, string>;
	/** Committee BONDS (pubkey → locked gBTC). A node bonds gBTC to be eligible for the
	 *  custody committee; the bond is its selection WEIGHT and is SLASHABLE on a proven
	 *  fault — so capturing a threshold of seats costs (and risks) real stake. Bonded
	 *  gBTC is locked: not spendable/transferable, but still 1:1-backed (counted in
	 *  conservation). */
	bonds: Map<string, bigint>;
	mintedTotal: bigint; // audit: lifetime minted
	paidOut: bigint; // audit: lifetime BTC paid out
}

export function emptyBridge(): BridgeState {
	return { gbtc: new Map(), reserves: 0n, processed: new Set(), pending: [], depositors: new Set(), claims: new Map(), broadcasts: new Map(), bonds: new Map(), mintedTotal: 0n, paidOut: 0n };
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

/** Total gBTC locked as committee bonds (still backed, just not spendable). */
export function bondedTotal(s: BridgeState): bigint {
	let t = 0n;
	for (const v of s.bonds.values()) t += v;
	return t;
}

/** Bond `amount` of `pubkey`'s FREE gBTC as a committee bond (locked). No-op if it
 *  can't cover it. The gBTC stays 1:1-backed; it just moves free → bonded. */
export function bond(s: BridgeState, pubkey: string, amount: bigint): boolean {
	if (amount <= 0n || gbtcOf(s, pubkey) < amount) return false;
	addG(s, pubkey, -amount); // out of free balance
	s.bonds.set(pubkey, (s.bonds.get(pubkey) ?? 0n) + amount);
	return true;
}

/** Unbond `amount` back to free gBTC. No-op if the bond can't cover it. (v1: immediate;
 *  an unbonding DELAY — so a caught equivocator can't dodge a slash — lands with slashing.) */
export function unbond(s: BridgeState, pubkey: string, amount: bigint): boolean {
	const cur = s.bonds.get(pubkey) ?? 0n;
	if (amount <= 0n || cur < amount) return false;
	const rest = cur - amount;
	if (rest === 0n) s.bonds.delete(pubkey);
	else s.bonds.set(pubkey, rest);
	addG(s, pubkey, amount); // back to free balance
	return true;
}

/** The 1:1 backing invariant — reserves account for exactly the outstanding claims
 *  (free + bonded gBTC + burned-pending). Bonded gBTC is still a claim on reserves. */
export function conserved(s: BridgeState): boolean {
	return s.reserves === totalGbtc(s) + bondedTotal(s) + pendingTotal(s);
}
/** Backing ratio in bps (10000 = fully 1:1 backed). Always 10000 if the invariant holds. */
export function backingBps(s: BridgeState): bigint {
	const owed = totalGbtc(s) + bondedTotal(s) + pendingTotal(s);
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
	s.depositors.add(att.depositor); // its per-user deposit address may hold fund BTC
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

// ── autonomous co-signing triggers (the work the committee picks up off-chain) ──

/** Record a deposit-mint request (the on-chain trigger). Idempotent by depositId. */
export function recordClaim(s: BridgeState, depositId: string, depositor: string): void {
	if (!s.claims.has(depositId)) s.claims.set(depositId, depositor);
}

/** Record a withdrawal's payout txid → marks it in flight (stop re-signing). */
export function recordBroadcast(s: BridgeState, withdrawalId: string, txid: string): void {
	if (!s.broadcasts.has(withdrawalId)) s.broadcasts.set(withdrawalId, txid);
}

/** Outstanding deposit-mint requests: a claim whose depositId hasn't been minted yet.
 *  Every committee member scans these, verifies the deposit on-chain, and co-signs. */
export function pendingClaims(s: BridgeState): { depositId: string; depositor: string }[] {
	const out: { depositId: string; depositor: string }[] = [];
	for (const [depositId, depositor] of s.claims) if (!s.processed.has(depositId)) out.push({ depositId, depositor });
	return out;
}

/** Pending withdrawals with NO payout broadcast yet — the committee should sign these. */
export function unsentWithdrawals(s: BridgeState): PendingWithdrawal[] {
	return s.pending.filter((w) => !s.broadcasts.has(w.id));
}

/** Pending withdrawals already broadcast — watch their txid for confirmation, then settle. */
export function inFlightWithdrawals(s: BridgeState): { withdrawal: PendingWithdrawal; txid: string }[] {
	const out: { withdrawal: PendingWithdrawal; txid: string }[] = [];
	for (const w of s.pending) {
		const txid = s.broadcasts.get(w.id);
		if (txid) out.push({ withdrawal: w, txid });
	}
	return out;
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
