/**
 * HTTP+JSON API for the web UI — a thin control surface over the Daemon.
 *
 * Localhost only. No deps (Node's http). All amounts are strings (BigInt-safe).
 * Writes pay the PoST cooldown, so action endpoints are async and can take a
 * few hundred ms.
 *
 *   GET  /api/state                       → { accounts, active, coins, auctions, balances }
 *   POST /api/accounts        {label}      → create + activate an identity
 *   POST /api/accounts/active {pubHex}     → switch the active identity
 *   POST /api/coins           {name,symbol,supply}        → deploy a coin
 *   POST /api/transfer        {token,to,amount}
 *   POST /api/auctions        {give,ask}    → create a listing (give: item|coin)
 *   POST /api/auctions/:id/bid    {token,amount}
 *   POST /api/auctions/:id/settle {winner}
 *   POST /api/auctions/:id/cancel
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Daemon } from "./daemon.ts";
import { mark, gbtcOf, BTC_ORACLE, MAX_LEVERAGE, skewBps, fundingRateBps, parseAmount, leverageOk } from "./market/btc.ts";
import { totalGbtc, pendingTotal, backingBps as bridgeBackingBps } from "./custody/bridge.ts";
import { backingBps, totalOwed } from "./perp/pool.ts";
import { unrealizedPnl, liquidationPrice } from "./perp/engine.ts";
import { DEFAULT_FUNDING } from "./perp/funding.ts";
import { DEFAULT_SOURCES } from "./market/pricefeed.ts";

const PORT = Number(process.env.GAVL_PORT ?? 6440);

// Space backend: real chiapos (real disk cost) when GAVL_SPACE=chiapos, else the stand-in.
const SPACE = process.env.GAVL_SPACE === "chiapos" ? "chiapos" : "standin";
// Difficulty schedule: ON by default so the VDF cost is the pace (anti fast-VDF reorg).
// GAVL_RETARGET=0 disables it (constant difficulty). GAVL_TARGET_ITERS tunes the per-anchor cost.
const RETARGET = process.env.GAVL_RETARGET !== "0";
const TARGET_ITERS = BigInt(process.env.GAVL_TARGET_ITERS ?? "200000");
// Idle heartbeat: when caught up, a lone node mints one anchor every this many ms.
// This sets the anchor cadence when there's no competing work, so it MUST match the
// time-estimate target (targetSecPerAnchor = 60s) — otherwise listing lifetimes,
// which are measured in anchors (MAX_LISTING_ANCHORS = 14_400 ≈ 10 days @ 60s),
// read at the wrong wall-clock. Upstream defaulted this to 120s, which made the
// 10-day cap display as ~20 days. Default it to 60s to match.
const HEARTBEAT_MS = Number(process.env.GAVL_HEARTBEAT_MS ?? "60000");

// Durable storage: ON by default (GAVL_PERSIST=off → in-memory only, lost on restart).
//   GAVL_PERSIST=all  (default) → archiver, keep every write
//   GAVL_PERSIST=mine            → keep only writes touching my wallet keys + their coins/auctions
const PERSIST = process.env.GAVL_PERSIST ?? "all";

// Channel/network: the name IS the address (its DHT topic is sha256 of it). GAVL_NETWORK
// sets the initial channel; the UI can switch at runtime. MESH/FARM gate consensus.
const NETWORK = process.env.GAVL_NETWORK ?? "gavl";
const MESH = process.env.GAVL_MESH !== "0";
const FARM = process.env.GAVL_FARM !== "0";

const daemon = new Daemon({
	network: NETWORK,
	bootstrapEnv: process.env.GAVL_BOOTSTRAP, // comma-separated host:port custom DHT entry nodes
	space: SPACE,
	schedule: RETARGET ? { base: 20n, targetIters: TARGET_ITERS, epoch: 4, window: 8, maxStep: 4n } : undefined,
	heartbeatMs: HEARTBEAT_MS,
	store: PERSIST === "off" ? undefined : { persist: PERSIST === "mine" ? "mine" : "all" },
});

// ── View → JSON (Maps + BigInts → plain, string amounts) ─────────

function serializeState() {
	const view = daemon.view(); // optimistic tip — reflects actions immediately
	const me = daemon.wallet.active().pubHex;
	const m = mark(view); // the BTC oracle price (null until first post)

	// gBTC balances: { pubkey: amount } (1:1 claims on BTC in the custody fund)
	const gbtc: Record<string, string> = {};
	for (const [pubkey, amt] of view.bridge.gbtc) gbtc[pubkey] = amt.toString();

	// my open positions (bull/bear), with live PnL at the current mark
	const myPositions = [...view.positions.values()]
		.filter((p) => p.owner === me)
		.map((p) => {
			const liq = liquidationPrice(p); // price at which you're force-closed, or null (1× = none)
			return {
				id: p.id,
				instrument: p.instrument,
				side: p.side,
				size: p.size.toString(),
				entry: p.entry.toString(),
				margin: p.margin.toString(),
				pnl: m != null ? unrealizedPnl(p, m).toString() : null,
				liq: liq != null ? liq.toString() : null, // null → no liquidation (fully collateralized)
			};
		});

	// the single shared pool: backing ratio (insolvency visible) + live funding
	const skew = m != null ? skewBps(view.positions.values(), m) : 0n;
	const rate = fundingRateBps(skew, DEFAULT_FUNDING);

	// The oracle(s) this market depends on — the price-authority, hence the v1 trust
	// point, surfaced explicitly. A LIST (future-proof for the multi-oracle design),
	// though v1 ships exactly one: the BTC price oracle both instruments mark against.
	// Provenance shown to clients. The METHODOLOGY (endpoints + keys) is disclosed
	// ON-CHAIN by the oracle (view.oracle.sources) so EVERY client sees it. The live
	// RAW values are publisher-local (only the node that fetches has them) and merged
	// in by endpoint when present.
	const disclosed = view.oracle.sources; // [{endpoint, key}] folded from oracle.meta — all clients
	const live = daemon.oracleSource(); // publisher-only live readings (raw values)
	let source: unknown = null;
	if (disclosed.length > 0) {
		source = {
			onChain: true,
			method: `average of ${disclosed.length} source${disclosed.length === 1 ? "" : "s"}`,
			ageMs: live ? Date.now() - live.at : null,
			feeds: disclosed.map((d) => {
				const r = live?.readings.find((x) => x.endpoint === d.endpoint);
				return { endpoint: d.endpoint, key: d.key, raw: r?.raw ?? null, value: r?.value != null ? r.value.toString() : null, error: r?.error ?? null };
			}),
		};
	} else if (live) {
		// publisher running but hasn't disclosed on-chain yet (e.g. fixed dev price)
		source = {
			onChain: false,
			method: live.method,
			ageMs: Date.now() - live.at,
			feeds: live.readings.map((r) => ({ endpoint: r.endpoint, key: r.key, raw: r.raw, value: r.value != null ? r.value.toString() : null, error: r.error ?? null })),
		};
	}
	const oracles = [
		{
			id: view.oracle.id, // the signing key IS the authority
			label: "BTC / USD price",
			feeds: ["BTC-BULL", "BTC-BEAR"], // which instruments it prices
			price: m != null ? m.toString() : null,
			seq: view.oracle.seq, // monotonic; update count = seq+1
			updates: view.oracle.seq + 1,
			live: m != null,
			mine: view.oracle.id === me, // is THIS node the publisher?
			source, // { onChain, method, ageMs, feeds:[{endpoint,key,raw,value,error}] } | null
		},
	];

	const rsv = daemon.onChainReservesCached(); // proof-of-reserves reading (cached, polled)
	const onChainR = rsv != null ? rsv.sats : null;
	// pay-when-able winnings queued to the active account (profit recorded but unpaid
	// until the pool has funds — i.e. a counterparty/LP). Surfaced so wins aren't invisible.
	const myOwed = view.pool.queue.filter((c) => c.owner === me).reduce((a, c) => a + c.amount, 0n);
	const market = {
		oracle: view.oracle.id,
		oracles,
		price: m != null ? m.toString() : null,
		oracleSeq: view.oracle.seq,
		maxLeverage: Number(MAX_LEVERAGE),
		poolAssets: view.pool.assets.toString(),
		owed: totalOwed(view.pool).toString(),
		backingBps: Number(backingBps(view.pool)), // perp-pool health (pay-when-able)
		openPositions: view.positions.size,
		skewBps: Number(skew), // +10000 all bull, −10000 all bear
		fundingRateBps: Number(rate), // >0 bulls pay, <0 bears pay
		fundingPays: rate > 0n ? "bulls" : rate < 0n ? "bears" : "none",
		fundingEpochAnchors: DEFAULT_FUNDING.epochAnchors,
		// collateral = gBTC, a 1:1 claim on BTC in the custody fund
		myGbtc: gbtcOf(view, me).toString(),
		myOwed: myOwed.toString(), // queued profit owed to you (awaiting a counterparty)
		reserves: view.bridge.reserves.toString(), // BTC sats in the fund
		gbtcOutstanding: (totalGbtc(view.bridge) + view.pool.assets).toString(),
		pending: pendingTotal(view.bridge).toString(), // burned, awaiting BTC payout
		pendingCount: view.bridge.pending.length,
		// the real Bitcoin custody fund: send (testnet) BTC here to deposit
		fundAddress: daemon.fundAddress(),
		btcNetwork: daemon.btcNetwork(),
		// proof of reserves: real on-chain BTC vs the ledger's claimed reserves
		onChainReserves: onChainR != null ? onChainR.toString() : null,
		reconciled: onChainR != null ? onChainR >= view.bridge.reserves : null, // real BTC covers the ledger?
		shortfall: onChainR != null ? (view.bridge.reserves > onChainR ? (view.bridge.reserves - onChainR).toString() : "0") : null,
		reservesCheckedAgoMs: rsv != null ? Date.now() - rsv.at : null,
		myPositions,
	};

	const accounts = daemon.wallet.list().map((a) => ({ label: a.label, pubHex: a.pubHex }));
	return { accounts, active: me, gbtc, market, consensus: daemon.consensus(), storage: daemon.storeStats() };
}

// ── helpers ──────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
	res.end(json);
}

/**
 * UX guard: mirror the fold's spend checks so a doomed write 400s with a reason
 * instead of folding to a silent no-op (the fold drops invalid ops without error,
 * which looks like a dead button in the UI). The fold stays authoritative — this
 * is feedback, not a security boundary.
 */
function requireSpendable(amountStr: string, label: string): bigint {
	const amt = parseAmount(amountStr);
	if (amt === null) throw new Error(`${label} must be a positive whole number of gBTC`);
	const have = gbtcOf(daemon.view(), daemon.wallet.active().pubHex);
	if (have < amt) throw new Error(`insufficient gBTC: you have ${have}, need ${amt} — deposit BTC to the fund and claim it first`);
	return amt;
}

function readBody(req: IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => {
			if (!data) return resolve({});
			try {
				resolve(JSON.parse(data));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

// ── routing ──────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
	const path = url.pathname;
	const method = req.method ?? "GET";

	if (method === "OPTIONS") return send(res, 204, {});

	if (method === "GET" && path === "/api/state") {
		return send(res, 200, serializeState());
	}

	if (method === "POST") {
		const body = await readBody(req);

		if (path === "/api/accounts") {
			const acct = daemon.createAccount(String(body.label ?? "account"));
			return send(res, 200, { pubHex: acct.pubHex });
		}
		if (path === "/api/accounts/active") {
			daemon.wallet.setActive(String(body.pubHex));
			return send(res, 200, { active: body.pubHex });
		}
		// ── BTC bull/bear (gBTC collateral) ──
		if (path === "/api/transfer") {
			if (!String(body.to ?? "").trim()) throw new Error("recipient pubkey required");
			requireSpendable(String(body.amount), "amount");
			await daemon.active().transfer(String(body.to), String(body.amount));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/withdraw") {
			// Burn gBTC to redeem BTC to a Bitcoin address → a pending withdrawal.
			if (!String(body.btcAddress ?? "").trim()) throw new Error("BTC address required");
			requireSpendable(String(body.amount), "amount");
			await daemon.active().withdraw(String(body.amount), String(body.btcAddress));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/deposit/claim") {
			// REAL deposit: verify a BTC txid paid the fund (via Esplora) → mint gBTC.
			const txid = String(body.txid ?? "").trim();
			// Validate the txid shape before hitting Esplora — a malformed id makes Esplora
			// 400 with a cryptic "esplora tx: HTTP 400". A txid is 64 hex chars.
			if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
				throw new Error(`txid must be 64 hex characters (got ${txid.length}) — paste the full Bitcoin transaction id`);
			}
			const credited = await daemon.claimDeposit(txid, daemon.wallet.active().pubHex);
			return send(res, 200, { credited: credited.toString() });
		}
		if (path === "/api/withdrawals/process") {
			// Build + threshold-sign + broadcast the pending withdrawals as one BTC tx.
			const txid = await daemon.processWithdrawals();
			return send(res, 200, { txid });
		}
		if (path === "/api/oracle/post") {
			// Publish a signed BTC price. Only valid if the active account IS the oracle key.
			await daemon.active().postPrice(String(body.oracle ?? BTC_ORACLE), String(body.price), Number(body.seq));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/position/open") {
			// instrument: "BTC-BULL" | "BTC-BEAR"; margin in credit; leverage ≤ MAX_LEVERAGE.
			if (mark(daemon.view()) === null) throw new Error("no oracle price yet — wait for the oracle's first post");
			const lev = parseAmount(String(body.leverage ?? "1"));
			if (lev === null || !leverageOk(lev)) throw new Error(`leverage must be a whole number from 1 to ${MAX_LEVERAGE}`);
			requireSpendable(String(body.margin), "margin");
			const id = await daemon.active().open(body.instrument === "BTC-BEAR" ? "BTC-BEAR" : "BTC-BULL", String(body.margin), String(body.leverage ?? "1"));
			return send(res, 200, { id });
		}
		if (path === "/api/position/close") {
			await daemon.active().close(String(body.position));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/position/liquidate") {
			await daemon.active().liquidate(String(body.position));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/pool/deposit") {
			requireSpendable(String(body.amount), "amount");
			await daemon.active().poolDeposit(String(body.amount));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/channel") {
			// Join a different channel by name. Each channel is its own economy (own anchor
			// chain + listings); your wallet/identity is shared. Returns once the switch lands.
			const name = String(body.name ?? "").trim();
			if (!name) return send(res, 400, { error: "channel name required" });
			await daemon.switchChannel(name);
			return send(res, 200, { channel: daemon.currentChannel() });
		}
		// ── identity control ──
		if (path === "/api/identity/reroll") {
			const pubHex = daemon.rerollIdentity(typeof body.label === "string" ? body.label : undefined);
			return send(res, 200, { pubHex });
		}
		if (path === "/api/identity/import") {
			const pubHex = daemon.importIdentity(String(body.seed ?? ""), typeof body.label === "string" ? body.label : undefined);
			return send(res, 200, { pubHex });
		}
		if (path === "/api/identity/export") {
			// Reveals the active identity's PRIVATE KEY (seed). Localhost only; never gossiped.
			return send(res, 200, { pubHex: daemon.wallet.active().pubHex, seed: daemon.exportActiveSeed() });
		}
		// ── peer control ──
		if (path === "/api/peers/dial") {
			// Directly dial a peer by node-key; pin (default) → re-dialed every boot (eclipse resistance).
			daemon.dialPeer(String(body.key ?? ""), body.pin !== false);
			return send(res, 200, { pinned: daemon.pinnedPeers() });
		}
		if (path === "/api/peers/unpin") {
			daemon.unpinPeer(String(body.key ?? ""));
			return send(res, 200, { pinned: daemon.pinnedPeers() });
		}
		// ── bootstrap control (DHT entry / "DNS" layer) ──
		if (path === "/api/bootstrap/add") {
			// "host:port" — added alongside Holepunch defaults, then reconnect through it.
			await daemon.addBootstrap(String(body.node ?? ""));
			return send(res, 200, { bootstrap: daemon.bootstrapNodes() });
		}
		if (path === "/api/bootstrap/remove") {
			await daemon.removeBootstrap(String(body.node ?? ""));
			return send(res, 200, { bootstrap: daemon.bootstrapNodes() });
		}
		if (path === "/api/bootstrap/reset") {
			await daemon.resetBootstrap(); // restore Holepunch's built-in defaults
			return send(res, 200, { bootstrap: daemon.bootstrapNodes() });
		}
		const claimMatch = path.match(/^\/api\/auctions\/([0-9a-f]+)\/claim$/);
		if (claimMatch) {
			const won = daemon.active().claimWon(claimMatch[1]);
			if (!won) return send(res, 400, { error: "nothing to claim (not winner, not settled, or already open)" });
			return send(res, 200, { name: won.name, plaintext: won.plaintext, verified: won.verified });
		}
		const bidMatch = path.match(/^\/api\/auctions\/([0-9a-f]+)\/(bid|settle|cancel)$/);
		if (bidMatch) {
			const [, id, action] = bidMatch;
			const acct = daemon.active();
			if (action === "bid") {
				validateBid(id, String(body.token), String(body.amount));
				await acct.bid(id, String(body.token), String(body.amount));
			}
			else if (action === "settle") await acct.settle(id, String(body.winner));
			else await acct.cancel(id);
			return send(res, 200, { ok: true });
		}
	}

	send(res, 404, { error: "not found" });
}

createServer((req, res) => {
	handle(req, res).catch((e) => send(res, 400, { error: String(e?.message ?? e) }));
}).listen(PORT, "127.0.0.1", async () => {
	console.log(`Gavl daemon API on http://127.0.0.1:${PORT}`);
	console.log(`  active account: ${daemon.wallet.active().label} (${daemon.wallet.active().pubHex.slice(0, 16)}…)`);
	const cc = daemon.consensus();
	console.log(`  consensus: network="${NETWORK}" mesh=${MESH} farming=${FARM} vdf=${cc.vdf} space=${cc.space} retarget=${RETARGET}`);

	// Durable storage: replay persisted writes into the ledger BEFORE going live.
	const replayed = await daemon.init();
	if (replayed) {
		const st = daemon.storeStats();
		console.log(`  storage: persist=${PERSIST}, replayed ${replayed.replayed} write(s) from disk — ${st?.policy ?? ""}`);
	} else {
		console.log(`  storage: in-memory only (GAVL_PERSIST=off) — writes are lost on restart`);
	}

	// Oracle publisher: only the node holding the oracle seed should run it
	// (GAVL_ORACLE_PUBLISH=1). Price source:
	//   GAVL_BTC_PRICE       → a fixed dev price (overrides the feeds), else
	//   GAVL_ORACLE_URL+_KEY → a single custom feed, else
	//   default              → AVERAGE of 3 BTC feeds (Coinbase, Kraken, Bitstamp).
	// Everyone else just folds the signed posts.
	const sources = process.env.GAVL_BTC_PRICE
		? [{ fixed: BigInt(process.env.GAVL_BTC_PRICE) }]
		: process.env.GAVL_ORACLE_URL
			? [{ url: process.env.GAVL_ORACLE_URL, key: process.env.GAVL_ORACLE_KEY }]
			: DEFAULT_SOURCES;
	const publishOracle = process.env.GAVL_ORACLE_PUBLISH === "1" ? { seedHex: process.env.GAVL_ORACLE_SEED, sources, everyMs: Number(process.env.GAVL_ORACLE_MS ?? "5000") } : undefined;
	await daemon.startConsensus({ network: NETWORK, mesh: MESH, farm: FARM, publishOracle });
	const c = daemon.consensus();
	console.log(`  → mesh ${c.mesh ? "joined" : "off"}, ${c.peers} peer(s), farming ${c.farming ? "live" : "off"}`);
});

process.on("SIGINT", async () => {
	await daemon.stop();
	process.exit(0);
});
