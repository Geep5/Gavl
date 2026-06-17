// Shared reactive app state (Svelte 5 runes). Polls the daemon and exposes the
// current view + active-account context + a refresh after every action.

import { api } from "./api.js";

export const store = $state({
	loading: true,
	error: null,
	accounts: [],
	active: null,
	gbtc: {}, // { pubkey: amount } gBTC balances (1:1 claim on BTC in the custody fund)
	market: null, // { price, oracles, myGbtc, idleDecay, reserves, gbtcOutstanding, depositAddress, tape, myContracts, ... }
	consensus: null, // { enabled, vdf, mesh, network, peers, farming, tip, finalizedHeight, secPerAnchor, secPerAnchorMeasured }
	custody: null, // { mode, epoch, fundKeyOnChain, fundAddress, holdsShare, committee, threshold, minCommittee, committeeId, bonded, myBond }
});

// Whether the current store.error came from refresh() (a connection problem) —
// only those may be cleared by a later successful poll. Action errors stay
// visible until the next action, instead of being wiped by the 2s poll.
let errorFromRefresh = false;

export async function refresh() {
	try {
		const s = await api.state();
		store.accounts = s.accounts;
		store.active = s.active;
		store.gbtc = s.gbtc ?? {};
		store.market = s.market ?? null;
		store.consensus = s.consensus ?? null;
		store.custody = s.custody ?? null;
		if (errorFromRefresh) {
			store.error = null;
			errorFromRefresh = false;
		}
	} catch (e) {
		store.error = String(e.message ?? e);
		errorFromRefresh = true;
	} finally {
		store.loading = false;
	}
}

/** Run an action then refresh; surfaces errors into the store. Returns true on success. */
export async function act(fn) {
	try {
		store.error = null;
		await fn();
		await refresh();
		return true;
	} catch (e) {
		await refresh();
		store.error = String(e.message ?? e);
		errorFromRefresh = false;
		return false;
	}
}

export function startPolling(ms = 2000) {
	refresh();
	return setInterval(refresh, ms);
}

// ── lookups ──────────────────────────────────────────────────────

/** Active account's gBTC balance (string). */
export function myGbtc() {
	return store.market?.myGbtc ?? store.gbtc[store.active] ?? "0";
}
export function accountLabel(pubHex) {
	const a = store.accounts.find((x) => x.pubHex === pubHex);
	return a ? a.label : short(pubHex);
}
export function short(h) {
	return h && h.length > 14 ? h.slice(0, 8) + "…" + h.slice(-4) : h;
}
