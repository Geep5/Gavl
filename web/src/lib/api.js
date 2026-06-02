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
	createItemAuction: (name, ask, details) => req("/auctions", "POST", { give: { kind: "item", name }, ask, details }),
	createCoinAuction: (token, amount, ask, details) => req("/auctions", "POST", { give: { kind: "coin", token, amount }, ask, details }),
	createSecretAuction: (name, secret, ask, details) => req("/secrets", "POST", { name, secret, ask, details }),
	bid: (id, token, amount) => req(`/auctions/${id}/bid`, "POST", { token, amount }),
	settle: (id, winner) => req(`/auctions/${id}/settle`, "POST", { winner }),
	cancel: (id) => req(`/auctions/${id}/cancel`, "POST", {}),
	claim: (id) => req(`/auctions/${id}/claim`, "POST", {}),
	switchChannel: (name) => req("/channel", "POST", { name }),
};
