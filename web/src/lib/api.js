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
	deployCoin: (name, symbol, supply) => req("/coins", "POST", { name, symbol, supply }),
	transfer: (token, to, amount) => req("/transfer", "POST", { token, to, amount }),
	// One unified listing: { name, coin?:{token,amount}, secret?, ask?:{token,amount}, details? }
	createListing: (payload) => req("/auctions", "POST", payload),
	bid: (id, token, amount) => req(`/auctions/${id}/bid`, "POST", { token, amount }),
	settle: (id, winner) => req(`/auctions/${id}/settle`, "POST", { winner }),
	cancel: (id) => req(`/auctions/${id}/cancel`, "POST", {}),
	claim: (id) => req(`/auctions/${id}/claim`, "POST", {}),
	switchChannel: (name) => req("/channel", "POST", { name }),
	rerollIdentity: (label) => req("/identity/reroll", "POST", { label }),
	importIdentity: (seed, label) => req("/identity/import", "POST", { seed, label }),
	exportSeed: () => req("/identity/export", "POST", {}),
	dialPeer: (key, pin = true) => req("/peers/dial", "POST", { key, pin }),
	unpinPeer: (key) => req("/peers/unpin", "POST", { key }),
	addBootstrap: (node) => req("/bootstrap/add", "POST", { node }),
	removeBootstrap: (node) => req("/bootstrap/remove", "POST", { node }),
	resetBootstrap: () => req("/bootstrap/reset", "POST", {}),
	// perpetuals
	deployPerp: (name, collateral) => req("/perps", "POST", { name, collateral }),
	perpOrder: (market, side, price, size, leverage) => req("/perps/order", "POST", { market, side, price, size, leverage }),
	perpClose: (market, position) => req("/perps/close", "POST", { market, position }),
	perpLiquidate: (market, position) => req("/perps/liquidate", "POST", { market, position }),
	perpDeposit: (market, amount) => req("/perps/deposit", "POST", { market, amount }),
};
