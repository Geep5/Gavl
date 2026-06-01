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
import { splitBalKey } from "./auction/state.ts";

const PORT = Number(process.env.GAVL_PORT ?? 6440);

// Space backend: real chiapos (real disk cost) when GAVL_SPACE=chiapos, else the stand-in.
const SPACE = process.env.GAVL_SPACE === "chiapos" ? "chiapos" : "standin";
// Difficulty schedule: ON by default so the VDF cost is the pace (anti fast-VDF reorg).
// GAVL_RETARGET=0 disables it (constant difficulty). GAVL_TARGET_ITERS tunes the per-anchor cost.
const RETARGET = process.env.GAVL_RETARGET !== "0";
const TARGET_ITERS = BigInt(process.env.GAVL_TARGET_ITERS ?? "200000");

// Durable storage: ON by default (GAVL_PERSIST=off → in-memory only, lost on restart).
//   GAVL_PERSIST=all  (default) → archiver, keep every write
//   GAVL_PERSIST=mine            → keep only writes touching my wallet keys + their coins/auctions
const PERSIST = process.env.GAVL_PERSIST ?? "all";
const daemon = new Daemon({
	space: SPACE,
	schedule: RETARGET ? { base: 20n, targetIters: TARGET_ITERS, epoch: 4, window: 8, maxStep: 4n } : undefined,
	store: PERSIST === "off" ? undefined : { persist: PERSIST === "mine" ? "mine" : "all" },
});

// ── View → JSON (Maps + BigInts → plain, string amounts) ─────────

function serializeState() {
	const view = daemon.view(); // optimistic tip — reflects actions immediately
	const finalAuctions = daemon.finalView().auctions; // which auctions are consensus-final

	const coins = [...view.coins.values()].map((c) => ({
		id: c.id,
		name: c.name,
		symbol: c.symbol,
		supply: c.supply.toString(),
		deployer: c.deployer,
	}));

	const nowHeight = daemon.finalizedHeight(); // current anchor-clock "now" (or null pre-consensus)
	const giveJson = (g) => (g.kind === "item" ? { kind: "item", itemId: g.itemId, name: g.name } : g.kind === "coin" ? { kind: "coin", token: g.token, amount: g.amount.toString() } : { kind: "secret", name: g.name, commitment: g.commitment });
	const auctions = [...view.auctions.values()].map((a) => {
		const fa = finalAuctions.get(a.id); // finalized counterpart (carries bornAt/expiresAt + expiry status)
		// Expiry lives in the finalized view (the only place with an anchor clock). Surface it
		// even while the optimistic status still says "open".
		const expiresAt = fa?.expiresAt ?? null;
		const expired = fa?.status === "expired";
		const remaining = expiresAt != null && nowHeight != null ? Math.max(0, expiresAt - nowHeight) : null;
		return {
			id: a.id,
			seller: a.seller,
			give: giveJson(a.give),
			ask: a.ask ? { token: a.ask.token, amount: a.ask.amount.toString() } : null,
			details: a.details ?? null,
			status: expired ? "expired" : a.status, // reflect anchor-clock expiry in the headline status
			bids: a.bids.map((b) => ({ ref: b.ref, bidder: b.bidder, token: b.token, amount: b.amount.toString(), inbox: b.inbox ?? null })),
			winner: a.winner ?? null,
			winnerPubkey: a.winnerPubkey ?? null,
			delivered: !!a.delivery, // secret auctions: has the sealed delivery been published?
			// true once the anchor chain has certified this auction's settlement/outcome.
			finalized: fa?.status === a.status && a.status !== "open",
			expiresAt, // anchor height at which it auto-cancels (null until certified)
			expiresIn: remaining, // anchors remaining (null pre-consensus)
		};
	});

	// balances: { pubkey: { token: amount } }
	const balances: Record<string, Record<string, string>> = {};
	for (const [key, amt] of view.balances) {
		const [token, pubkey] = splitBalKey(key);
		(balances[pubkey] ??= {})[token] = amt.toString();
	}

	const accounts = daemon.wallet.list().map((a) => ({ label: a.label, pubHex: a.pubHex }));
	// active account's inventory of won secrets (decrypted locally, never on the wire)
	const inventory = daemon.active().vault?.won() ?? [];
	return { accounts, active: daemon.wallet.active().pubHex, coins, auctions, balances, inventory, consensus: daemon.consensus(), storage: daemon.storeStats() };
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
		if (path === "/api/coins") {
			const id = await daemon.active().deployCoin(String(body.name), String(body.symbol), String(body.supply));
			return send(res, 200, { id });
		}
		if (path === "/api/transfer") {
			await daemon.active().transfer(String(body.token), String(body.to), String(body.amount));
			return send(res, 200, { ok: true });
		}
		if (path === "/api/auctions") {
			// body.give = {kind:"item",name} | {kind:"coin",token,amount};  body.ask = {token,amount}|null
			// body.details = opaque offer body (free-form YAML), optional
			const id = await daemon.active().create(body.give, body.ask ?? null, typeof body.details === "string" ? body.details : undefined);
			return send(res, 200, { id });
		}
		if (path === "/api/secrets") {
			// Sell a sealed secret: { name, secret, ask?, details? }. Plaintext is vaulted locally,
			// only the commitment is published. NOT fair exchange — seller keeps a copy.
			const id = await daemon.active().createSecretAuction(String(body.name), String(body.secret), body.ask ?? null, typeof body.details === "string" ? body.details : undefined);
			return send(res, 200, { id });
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
			if (action === "bid") await acct.bid(id, String(body.token), String(body.amount));
			else if (action === "settle") await acct.settle(id, String(body.winner));
			else await acct.cancel(id);
			return send(res, 200, { ok: true });
		}
	}

	send(res, 404, { error: "not found" });
}

// Consensus config. Mesh + farming are ON by default so the UI shows real
// consensus; GAVL_MESH=0 / GAVL_FARM=0 disable them, GAVL_NETWORK sets the topic.
const NETWORK = process.env.GAVL_NETWORK ?? "gavl";
const MESH = process.env.GAVL_MESH !== "0";
const FARM = process.env.GAVL_FARM !== "0";

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

	await daemon.startConsensus({ network: NETWORK, mesh: MESH, farm: FARM });
	const c = daemon.consensus();
	console.log(`  → mesh ${c.mesh ? "joined" : "off"}, ${c.peers} peer(s), farming ${c.farming ? "live" : "off"}`);
});

process.on("SIGINT", async () => {
	await daemon.stop();
	process.exit(0);
});
