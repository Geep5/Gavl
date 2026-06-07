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
import { mark, creditOf, BTC_ORACLE, MAX_LEVERAGE, skewBps, fundingRateBps } from "./market/btc.ts";
import { backingBps, totalOwed } from "./perp/pool.ts";
import { unrealizedPnl } from "./perp/engine.ts";
import { DEFAULT_FUNDING } from "./perp/funding.ts";

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

	// credit balances: { pubkey: amount }
	const credit: Record<string, string> = {};
	for (const [pubkey, amt] of view.credit) credit[pubkey] = amt.toString();

	// my open positions (bull/bear), with live PnL at the current mark
	const myPositions = [...view.positions.values()]
		.filter((p) => p.owner === me)
		.map((p) => ({
			id: p.id,
			instrument: p.instrument,
			side: p.side,
			size: p.size.toString(),
			entry: p.entry.toString(),
			margin: p.margin.toString(),
			pnl: m != null ? unrealizedPnl(p, m).toString() : null,
		}));

	// the single shared pool: backing ratio (insolvency visible) + live funding
	const skew = m != null ? skewBps(view.positions.values(), m) : 0n;
	const rate = fundingRateBps(skew, DEFAULT_FUNDING);

	// The oracle(s) this market depends on — the price-authority, hence the v1 trust
	// point, surfaced explicitly. A LIST (future-proof for the multi-oracle design),
	// though v1 ships exactly one: the BTC price oracle both instruments mark against.
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
			webhook: null, // v1 publishes via signed writes, not a fetch endpoint
		},
	];

	const market = {
		oracle: view.oracle.id,
		oracles,
		price: m != null ? m.toString() : null,
		oracleSeq: view.oracle.seq,
		maxLeverage: Number(MAX_LEVERAGE),
		poolAssets: view.pool.assets.toString(),
		owed: totalOwed(view.pool).toString(),
		backingBps: Number(backingBps(view.pool)), // 10000 = 100% backed; < 10000 = insolvent
		openPositions: view.positions.size,
		skewBps: Number(skew), // +10000 all bull, −10000 all bear
		fundingRateBps: Number(rate), // >0 bulls pay, <0 bears pay
		fundingPays: rate > 0n ? "bulls" : rate < 0n ? "bears" : "none",
		fundingEpochAnchors: DEFAULT_FUNDING.epochAnchors,
		myCredit: creditOf(view, me).toString(),
		myPositions,
	};

	const accounts = daemon.wallet.list().map((a) => ({ label: a.label, pubHex: a.pubHex }));
	return { accounts, active: me, credit, market, consensus: daemon.consensus(), storage: daemon.storeStats() };
}

// ── helpers ──────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST,OPTIONS" });
	res.end(json);
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
		// ── v1: BTC bull/bear ──
		if (path === "/api/farm") {
			// Mint native credit by doing the PoST work (v1's "money"; real BTC in Phase 4).
			await daemon.active().farm();
			return send(res, 200, { ok: true });
		}
		if (path === "/api/transfer") {
			await daemon.active().transfer(String(body.to), String(body.amount));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/oracle/post") {
			// Publish a signed BTC price. Only valid if the active account IS the oracle key.
			await daemon.active().postPrice(String(body.oracle ?? BTC_ORACLE), String(body.price), Number(body.seq));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/position/open") {
			// instrument: "BTC-BULL" | "BTC-BEAR"; margin in credit; leverage ≤ MAX_LEVERAGE.
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
	// (GAVL_ORACLE_PUBLISH=1). v1 price source is a fixed dev price (GAVL_BTC_PRICE,
	// default 50000) — a real feed swaps in here later. Everyone else just folds
	// the signed posts.
	const publishOracle = process.env.GAVL_ORACLE_PUBLISH === "1" ? { seedHex: process.env.GAVL_ORACLE_SEED, price: () => BigInt(process.env.GAVL_BTC_PRICE ?? "50000"), everyMs: Number(process.env.GAVL_ORACLE_MS ?? "5000") } : undefined;
	await daemon.startConsensus({ network: NETWORK, mesh: MESH, farm: FARM, publishOracle });
	const c = daemon.consensus();
	console.log(`  → mesh ${c.mesh ? "joined" : "off"}, ${c.peers} peer(s), farming ${c.farming ? "live" : "off"}`);
});

process.on("SIGINT", async () => {
	await daemon.stop();
	process.exit(0);
});
