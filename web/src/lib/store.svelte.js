// Shared reactive app state (Svelte 5 runes). Polls the daemon and exposes the
// current view + active-account context + a refresh after every action.

import { api } from "./api.js";

export const store = $state({
	loading: true,
	error: null,
	accounts: [],
	active: null,
	credit: {}, // { pubkey: amount } native-credit balances
	market: null, // the single BTC market: { price, backingBps, skewBps, fundingRateBps, fundingPays, maxLeverage, poolAssets, owed, myCredit, myPositions, ... }
	consensus: null, // { enabled, vdf, mesh, network, peers, farming, tip, finalizedHeight, secPerAnchor, secPerAnchorMeasured }
});

export async function refresh() {
	try {
		const s = await api.state();
		store.accounts = s.accounts;
		store.active = s.active;
		store.credit = s.credit ?? {};
		store.market = s.market ?? null;
		store.consensus = s.consensus ?? null;
		store.error = null;
	} catch (e) {
		store.error = String(e.message ?? e);
	} finally {
		store.loading = false;
	}
}

/** Run an action then refresh; surfaces errors into the store. */
export async function act(fn) {
	try {
		store.error = null;
		await fn();
	} catch (e) {
		store.error = String(e.message ?? e);
	}
	await refresh();
}

export function startPolling(ms = 2000) {
	refresh();
	return setInterval(refresh, ms);
}

// ── lookups ──────────────────────────────────────────────────────

/** Active account's native-credit balance (string). */
export function myCredit() {
	return store.market?.myCredit ?? store.credit[store.active] ?? "0";
}
export function accountLabel(pubHex) {
	const a = store.accounts.find((x) => x.pubHex === pubHex);
	return a ? a.label : short(pubHex);
}
export function short(h) {
	return h && h.length > 14 ? h.slice(0, 8) + "…" + h.slice(-4) : h;
}
