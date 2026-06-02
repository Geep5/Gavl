/**
 * Auction-house state — a pure function of the writes the ledger holds.
 *
 *   computeView(writes) -> { coins, balances, items, auctions }
 *
 * The house is COIN-AGNOSTIC: no token id is privileged. A coin is deployed by
 * `coin.deploy` (its id = the deploy-write's id) and its supply is minted to the
 * deployer; thereafter transfers/bids/asks/gives name the token explicitly. The
 * protocol mints nothing on its own — the PoST cooldown only rate-limits writes.
 *
 * Conservation is strict and per-token: you cannot spend, bid, or escrow coins
 * you do not hold; invalid ops are deterministically skipped. Because the view
 * is pure over the write set, every node with the same writes computes the same
 * view.
 *
 * ORDERING (provisional): writes are applied in `(ts, writer, seq)` order. The
 * `ts` is honest-but-attacker-settable foliage — fine for a cooperative network
 * and good enough to demo, but the anchor layer (consensus/order.ts) provides
 * the canonical PoST-weight-bound order. Conservation already makes nonsensical
 * orderings safe (e.g. a settle seen before its bids simply finds no winner).
 */

import type { Write } from "../chain/writer.ts";
import type { Op, Price } from "./ops.ts";
import { isOp } from "./ops.ts";

/** A deployed coin's metadata. */
export interface Coin {
	id: string;
	name: string;
	symbol: string;
	supply: bigint;
	deployer: string;
}

export interface Bid {
	/** The bid-write's id — how the seller names a winner. */
	ref: string;
	bidder: string;
	token: string;
	amount: bigint;
	/** Bidder's X25519 sealed-box public key (hex), for secret delivery. Optional. */
	inbox?: string;
}

/** A resolved view of what a listing contains. Always a named item (by id); optionally
 *  a bundled escrowed coin amount and/or a sealed secret. */
export interface Contents {
	itemId: string;
	name: string;
	coin?: { token: string; amount: bigint };
	secret?: { commitment: string };
}

/** Max bytes of the opaque offer body. Over-cap creates are skipped (deterministic). */
export const MAX_DETAILS_BYTES = 8192;

/**
 * Maximum lifetime of a listing, measured in ANCHORS (not seconds — there is no
 * trustworthy wall clock). The anchor chain is produced at a difficulty-targeted
 * cadence, so anchor height IS the network's decentralized clock. At the default
 * ~1 anchor/minute target this is ~10 days; "days" is approximate and tracks the
 * anchor cadence (like Bitcoin's "~10 min blocks"). An auction still open this
 * many anchors after the one that first certified it auto-cancels: the give is
 * released to the seller and all bids refunded. Deterministic — every node with
 * the same anchor chain computes the same expiry.
 *
 * This is a HARDCODED CONSENSUS CONSTANT, not configurable. Every node MUST agree
 * on it, or they compute different expiries and diverge — so it is baked in, the
 * same way the block reward or a coin's conservation rule is. There is no env
 * knob and no per-listing override: a seller cannot opt out, extend, or shorten
 * it. Changing it is a protocol change (a fork), identical for all nodes.
 */
export const MAX_LISTING_ANCHORS = 14_400;

export interface Auction {
	id: string;
	seller: string;
	contents: Contents;
	/** Advisory ask price (any coin), or null for open-to-bids. */
	ask: { token: string; amount: bigint } | null;
	/** Opaque seller-authored offer body (free-form YAML in the UI), or undefined. */
	details?: string;
	status: "open" | "settled" | "cancelled" | "expired";
	bids: Bid[];
	/** Winning bid ref + winner, once settled. */
	winner?: string;
	winnerPubkey?: string;
	/** For a settled secret auction: the secret sealed to the winner's inbox (hex). Opaque. */
	delivery?: string;
	/** Anchor height that first certified this listing (its clock origin). Set only in the finalized view. */
	bornAt?: number;
	/** Anchor height at which it auto-cancels = bornAt + MAX_LISTING_ANCHORS. Finalized view only. */
	expiresAt?: number;
}

export interface View {
	/** Deployed coins by id. */
	coins: Map<string, Coin>;
	/** Balances keyed by `${token} ${pubkey}` (escrowed amounts are debited until resolved). */
	balances: Map<string, bigint>;
	/** itemId (= auctionId for item auctions) → current owner. */
	items: Map<string, { name: string; owner: string }>;
	auctions: Map<string, Auction>;
}

// ── balance helpers (keyed by token + pubkey) ────────────────────

/** Separator between token id and pubkey in a balance key. Both sides are hex, so any non-hex char is safe. */
export const BAL_SEP = "/";
function balKey(token: string, pubkey: string): string {
	return token + BAL_SEP + pubkey;
}
/** Split a balance-map key back into [token, pubkey]. */
export function splitBalKey(key: string): [string, string] {
	const i = key.indexOf(BAL_SEP);
	return [key.slice(0, i), key.slice(i + 1)];
}
function bal(m: Map<string, bigint>, token: string, pubkey: string): bigint {
	return m.get(balKey(token, pubkey)) ?? 0n;
}
function add(m: Map<string, bigint>, token: string, pubkey: string, v: bigint): void {
	const k = balKey(token, pubkey);
	const next = (m.get(k) ?? 0n) + v;
	if (next === 0n) m.delete(k);
	else m.set(k, next);
}

/** Read a balance from a View (for callers/UI). */
export function balanceOf(view: View, token: string, pubkey: string): bigint {
	return bal(view.balances, token, pubkey);
}

function parseAmount(s: string): bigint | null {
	if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
	try {
		const n = BigInt(s);
		return n > 0n ? n : null;
	} catch {
		return null;
	}
}

function parsePrice(p: Price | null): { token: string; amount: bigint } | null | undefined {
	if (p === null) return null; // open-to-bids
	if (!p || typeof p.token !== "string") return undefined; // malformed
	const amt = parseAmount(p.amount);
	return amt === null ? undefined : { token: p.token, amount: amt };
}

function cmpWrite(a: Write, b: Write): number {
	if (a.ts !== b.ts) return a.ts - b.ts;
	if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
	return a.seq - b.seq;
}

export interface ViewOptions {
	/** Fold order. Defaults to the provisional `(ts, writer, seq)`; the anchor layer passes a PoST-bound order. */
	order?: (a: Write, b: Write) => number;
	/** writeId → certifying anchor height (the listing's clock origin). Enables anchor-clock expiry. */
	bornAt?: Map<string, number>;
	/** Current finalized anchor height ("now" on the decentralized clock). Required for expiry. */
	nowHeight?: number;
}

export function computeView(writes: Write[], opts: ViewOptions = {}): View {
	const cmp = opts.order ?? cmpWrite;
	const view: View = { coins: new Map(), balances: new Map(), items: new Map(), auctions: new Map() };
	const ordered = [...writes].sort(cmp);
	for (const w of ordered) {
		const op = w.payload as Op | null;
		if (isOp(op)) {
			// Lazily expire any past-deadline auctions BEFORE applying this op, so e.g.
			// a bid on an expired listing is correctly rejected. Uses the anchor clock,
			// never Date.now() — keeping the fold deterministic across nodes.
			expireDue(view, opts);
			applyOp(view, w, op);
			// Stamp the clock origin the first time we see a create (finalized view only).
			if (op.kind === "auction.create" && opts.bornAt?.has(w.id)) {
				const a = view.auctions.get(w.id);
				if (a) {
					a.bornAt = opts.bornAt.get(w.id);
					a.expiresAt = a.bornAt! + MAX_LISTING_ANCHORS;
				}
			}
		}
	}
	// Final sweep: expire listings whose deadline passed with no later activity.
	expireDue(view, opts);
	return view;
}

/** Auto-cancel every open auction whose expiry height has passed (anchor clock). */
function expireDue(view: View, opts: ViewOptions): void {
	if (opts.nowHeight === undefined) return; // no clock (optimistic view) → no expiry
	for (const a of view.auctions.values()) {
		if (a.status !== "open" || a.expiresAt === undefined) continue;
		if (opts.nowHeight >= a.expiresAt) {
			releaseContents(view, a.contents, a.seller); // item + bundled coins back to seller
			for (const b of a.bids) add(view.balances, b.token, b.bidder, b.amount); // refund all bids
			a.status = "expired";
		}
	}
}

function applyOp(view: View, w: Write, op: Op): void {
	switch (op.kind) {
		case "coin.deploy": {
			if (view.coins.has(w.id)) return; // id is content-addressed; collisions impossible
			const supply = parseAmount(op.supply);
			if (supply === null) return;
			if (typeof op.name !== "string" || typeof op.symbol !== "string") return;
			view.coins.set(w.id, { id: w.id, name: op.name, symbol: op.symbol, supply, deployer: w.writer });
			add(view.balances, w.id, w.writer, supply); // mint the full supply to the deployer
			return;
		}
		case "transfer": {
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.token !== "string" || typeof op.to !== "string") return;
			if (bal(view.balances, op.token, w.writer) < amt) return; // can't overspend
			add(view.balances, op.token, w.writer, -amt);
			add(view.balances, op.token, op.to, amt);
			return;
		}
		case "auction.create": {
			if (view.auctions.has(w.id)) return; // id is content-addressed; collisions impossible
			if (typeof op.name !== "string" || op.name.length === 0) return; // every listing has a name
			const ask = parsePrice(op.ask);
			if (ask === undefined) return; // malformed ask
			let details: string | undefined;
			if (op.details !== undefined) {
				if (typeof op.details !== "string") return; // malformed
				if (Buffer.byteLength(op.details, "utf8") > MAX_DETAILS_BYTES) return; // over cap → skip (deterministic)
				details = op.details;
			}
			const contents = escrowContents(view, w, op);
			if (!contents) return; // a bundled coin/secret was malformed or unaffordable → skip whole listing
			view.items.set(w.id, { name: op.name, owner: w.writer }); // the listing is itself a unique item, escrowed to the seller
			view.auctions.set(w.id, { id: w.id, seller: w.writer, contents, ask, details, status: "open", bids: [] });
			return;
		}
		case "auction.bid": {
			const a = view.auctions.get(op.auction);
			if (!a || a.status !== "open") return;
			if (w.writer === a.seller) return; // no self-bidding
			const amt = parseAmount(op.amount);
			if (amt === null || typeof op.token !== "string") return;
			if (bal(view.balances, op.token, w.writer) < amt) return; // must cover the bid
			add(view.balances, op.token, w.writer, -amt); // escrow (lock) the offer
			const inbox = typeof op.inbox === "string" ? op.inbox : undefined;
			a.bids.push({ ref: w.id, bidder: w.writer, token: op.token, amount: amt, inbox });
			return;
		}
		case "auction.settle": {
			const a = view.auctions.get(op.auction);
			if (!a || a.status !== "open") return;
			if (w.writer !== a.seller) return; // only the seller settles
			const win = a.bids.find((b) => b.ref === op.winner);
			if (!win) return; // must name an actual bid
			// A listing bundling a secret can only settle to a bid that supplied a delivery
			// inbox, and the settle must carry the sealed delivery — else the secret part fails.
			if (a.contents.secret) {
				if (!win.inbox || typeof op.delivery !== "string") return;
				a.delivery = op.delivery; // opaque ciphertext, sealed to win.inbox
			}
			add(view.balances, win.token, a.seller, win.amount); // payment → seller
			releaseContents(view, a.contents, win.bidder); // item + bundled coins → winner
			for (const b of a.bids) if (b.ref !== win.ref) add(view.balances, b.token, b.bidder, b.amount); // refund losers
			a.status = "settled";
			a.winner = win.ref;
			a.winnerPubkey = win.bidder;
			return;
		}
		case "auction.cancel": {
			const a = view.auctions.get(op.auction);
			if (!a || a.status !== "open") return;
			if (w.writer !== a.seller) return;
			releaseContents(view, a.contents, a.seller); // return item + bundled coins to the seller
			for (const b of a.bids) add(view.balances, b.token, b.bidder, b.amount); // refund all
			a.status = "cancelled";
			return;
		}
	}
}

/**
 * Validate + escrow a listing's optional bundled coin/secret, debiting the seller.
 * The named item itself is escrowed by the create case (view.items). Returns the
 * resolved Contents, or null if any bundled part is malformed/unaffordable — in
 * which case the whole listing is skipped (atomic: no partial escrow).
 */
function escrowContents(view: View, w: Write, op: { name: string; coin?: { token: string; amount: string }; secret?: { commitment: string } }): Contents | null {
	const contents: Contents = { itemId: w.id, name: op.name };

	if (op.coin !== undefined) {
		const amt = parseAmount(op.coin.amount);
		if (amt === null || typeof op.coin.token !== "string") return null;
		if (bal(view.balances, op.coin.token, w.writer) < amt) return null; // can't escrow coins you don't hold
		add(view.balances, op.coin.token, w.writer, -amt); // lock the amount out of the seller's balance
		contents.coin = { token: op.coin.token, amount: amt };
	}

	if (op.secret !== undefined) {
		// Nothing balance-wise to escrow — the seller commits to a secret by its hash.
		// 64 hex chars = sha256; reject anything else so the commitment is well-formed.
		if (typeof op.secret.commitment !== "string" || !/^[0-9a-f]{64}$/.test(op.secret.commitment)) return null;
		contents.secret = { commitment: op.secret.commitment };
	}

	return contents;
}

/** Release a listing's item + bundled coins to `recipient` (winner on settle, seller on cancel).
 *  The secret (if any) is delivered via the sealed `delivery` recorded on the auction, not here. */
function releaseContents(view: View, contents: Contents, recipient: string): void {
	const item = view.items.get(contents.itemId);
	if (item) item.owner = recipient;
	if (contents.coin) add(view.balances, contents.coin.token, recipient, contents.coin.amount);
}
