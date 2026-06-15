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
	deposit: (amount) => req("/deposit", "POST", { amount }), // dev: mint test gBTC (bridge attestor)
	claimDeposit: (txid) => req("/deposit/claim", "POST", { txid }), // REAL: verify a BTC txid → mint
	transfer: (to, amount) => req("/transfer", "POST", { to, amount }),
	withdraw: (amount, btcAddress) => req("/withdraw", "POST", { amount, btcAddress }),
	processWithdrawals: () => req("/withdrawals/process", "POST", {}),
	// matched market (real counterparty, no pool)
	broadcastIntent: (side, size, leverage) => req("/intent/broadcast", "POST", { side, size, leverage }),
	takeIntent: (nonce, fill) => req("/intent/take", "POST", { nonce, fill }),
	takePosition: (side, size) => req("/intent/take-position", "POST", { side, size }),
	settleContract: (contractId) => req("/contract/settle", "POST", { contractId }),
	switchChannel: (name) => req("/channel", "POST", { name }),
	testMarket: (endpoint, key) => req("/market/test", "POST", { endpoint, key }),
	rerollIdentity: (label) => req("/identity/reroll", "POST", { label }),
	importIdentity: (seed, label) => req("/identity/import", "POST", { seed, label }),
	exportSeed: () => req("/identity/export", "POST", {}),
	dialPeer: (key, pin = true) => req("/peers/dial", "POST", { key, pin }),
	unpinPeer: (key) => req("/peers/unpin", "POST", { key }),
	addBootstrap: (node) => req("/bootstrap/add", "POST", { node }),
	removeBootstrap: (node) => req("/bootstrap/remove", "POST", { node }),
	resetBootstrap: () => req("/bootstrap/reset", "POST", {}),
};
