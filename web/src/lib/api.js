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
	events: (since = 0) => req("/events?since=" + since), // network-activity feed (seq cursor; never misses)
	createAccount: (label) => req("/accounts", "POST", { label }),
	setActive: (pubHex) => req("/accounts/active", "POST", { pubHex }),
	// v1: BTC bull/bear
	deposit: (amount) => req("/deposit", "POST", { amount }), // dev: mint test gBTC (bridge attestor)
	claimDeposit: (txid) => req("/deposit/claim", "POST", { txid }), // REAL: verify a BTC txid → mint
	transfer: (to, amount) => req("/transfer", "POST", { to, amount }),
	withdraw: (amount, btcAddress, fee) => req("/withdraw", "POST", { amount, btcAddress, fee }),
	processWithdrawals: () => req("/withdrawals/process", "POST", {}),
	// matched market (real counterparty, no pool)
	broadcastIntent: (side, size, leverage, spread) => req("/intent/broadcast", "POST", { side, size, leverage, spread }),
	takeIntent: (nonce, fill, maxSpread) => req("/intent/take", "POST", { nonce, fill, maxSpread }),
	takePosition: (side, size, maxSpread) => req("/intent/take-position", "POST", { side, size, maxSpread }),
	settleContract: (contractId) => req("/contract/settle", "POST", { contractId }),
	// Gavl Rounds — the 1-click bull/bear (idx optional: defaults to the currently-accepting round)
	rounds: () => req("/rounds"),
	enterRound: (side, stake, idx) => req("/round/enter", "POST", { side, stake, idx }),
	autopilot: () => req("/autopilot"),
	setAutopilot: (cfg) => req("/autopilot", "POST", cfg), // any subset of the config; returns live status
	switchChannel: (name) => req("/channel", "POST", { name }),
	testPythFeed: (feedId) => req("/market/test", "POST", { feedId }),
	rerollIdentity: (label) => req("/identity/reroll", "POST", { label }),
	importIdentity: (seed, label) => req("/identity/import", "POST", { seed, label }),
	exportSeed: () => req("/identity/export", "POST", {}),
	dialPeer: (key, pin = true) => req("/peers/dial", "POST", { key, pin }),
	unpinPeer: (key) => req("/peers/unpin", "POST", { key }),
	setGossipInterval: (seconds) => req("/gossip-interval", "POST", { seconds }), // live-tune re-announce cadence
	fleetUp: () => req("/fleet/up", "POST", {}), // spin up one more local node (own data dir + port + plot)
	fleetDown: () => req("/fleet/down", "POST", {}), // stop the most-recent local node
};
