// Thin client for the daemon's JSON API. All amounts are strings (BigInt-safe).

async function req(path, method = "GET", body) {
	const res = await fetch(`/api${path}`, {
		method,
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

export const api = {
	state: () => req("/state"),
	createAccount: (label) => req("/accounts", "POST", { label }),
	setActive: (pubHex) => req("/accounts/active", "POST", { pubHex }),
	// v1: BTC bull/bear
	farm: () => req("/farm", "POST", {}),
	transfer: (to, amount) => req("/transfer", "POST", { to, amount }),
	open: (instrument, margin, leverage) => req("/position/open", "POST", { instrument, margin, leverage }),
	closePosition: (position) => req("/position/close", "POST", { position }),
	liquidate: (position) => req("/position/liquidate", "POST", { position }),
	poolDeposit: (amount) => req("/pool/deposit", "POST", { amount }),
	switchChannel: (name) => req("/channel", "POST", { name }),
	rerollIdentity: (label) => req("/identity/reroll", "POST", { label }),
	importIdentity: (seed, label) => req("/identity/import", "POST", { seed, label }),
	exportSeed: () => req("/identity/export", "POST", {}),
	dialPeer: (key, pin = true) => req("/peers/dial", "POST", { key, pin }),
	unpinPeer: (key) => req("/peers/unpin", "POST", { key }),
	addBootstrap: (node) => req("/bootstrap/add", "POST", { node }),
	removeBootstrap: (node) => req("/bootstrap/remove", "POST", { node }),
	resetBootstrap: () => req("/bootstrap/reset", "POST", {}),
};
