/**
 * HTTP+JSON API for the desktop app — a thin control surface over the Daemon.
 *
 * Localhost only. No deps (Node's http). All amounts are strings (BigInt-safe).
 * Writes pay the PoST cooldown, so action endpoints are async and can take a
 * few hundred ms.
 *
 *   GET  /api/state                         → { accounts, active, consensus, storage, fleet }
 *   GET  /api/events?since=N                → network/diagnostic log page
 *   GET  /api/offers                        → { height, offers }   listed offers as of the tip anchor
 *   GET  /api/matches[?mine=1]              → { height, matches }  matches (mine: my identities' only)
 *   POST /api/offer   {give:{chain,amount}, want:{chain,amount}, minFill, expiresIn?} → { offerId }
 *   POST /api/take    {offerId, fill}       → { matchId, hash, takerKey }  (secret + key derived from the seed)
 *   POST /api/cancel  {offerId}             → { writeId }
 *   POST /api/accounts            {label}   → create + activate an identity
 *   POST /api/accounts/active     {pubHex}  → switch the active identity
 *   POST /api/channel             {name}    → switch channel
 *   POST /api/identity/reroll|import|export, /api/peers/dial|unpin, /api/gossip-interval, /api/fleet/up|down
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createServer as netServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Daemon } from "./daemon.ts";
import { defaultParams } from "./config.ts";

const PORT = Number(process.env.GAVL_PORT ?? 6440);

// Space backend: real chiapos (real disk cost) is the DEFAULT — real Proof-of-Space-Time out of the
// box. Opt out with GAVL_SPACE=standin (the light in-memory stand-in for tests / CI / zero-setup dev).
const SPACE = process.env.GAVL_SPACE === "standin" ? "standin" : "chiapos";

// DIAGNOSTIC (1): real PoST needs the Python venv (chiavdf / chiapos). Fail FAST + LOUD here if it's
// missing, rather than letting a node that forgot `npm run setup:chia` farm with a worker that can't
// start — the silent "connected but never produces an anchor" trap. Stand-in mode needs nothing.
if (process.env.GAVL_VDF !== "hash" || SPACE === "chiapos") {
	const root = dirname(dirname(fileURLToPath(import.meta.url)));
	const venvPy = process.platform === "win32" ? join(root, ".venv", "Scripts", "python.exe") : join(root, ".venv", "bin", "python3");
	if (!existsSync(venvPy)) {
		console.error("\n✗ Real Proof-of-Space-Time needs the Python venv (chiavdf + chiapos), but `.venv` is missing.");
		console.error("  Set it up once:                      npm run setup:chia");
		console.error("  Or run the zero-setup stand-ins:     npm run dev:hash\n");
		process.exit(1);
	}
}
// Difficulty schedule: ON by default so the VDF cost is the pace (anti fast-VDF reorg).
// GAVL_RETARGET=0 disables it (constant difficulty). GAVL_TARGET_ITERS tunes the per-anchor cost.
const RETARGET = process.env.GAVL_RETARGET !== "0";
const TARGET_ITERS = BigInt(process.env.GAVL_TARGET_ITERS ?? "200000");
// Idle heartbeat: when caught up, a lone node mints one anchor every this many ms.
// This sets the anchor cadence when there's no competing work, so it MUST match the
// time-estimate target (targetSecPerAnchor = 60s) — otherwise anchor-counted durations
// read at the wrong wall-clock. Default it to 60s to match.
const HEARTBEAT_MS = Number(process.env.GAVL_HEARTBEAT_MS ?? "60000");

// Durable storage: ON by default (GAVL_PERSIST=off → in-memory only, lost on restart).
//   GAVL_PERSIST=all  (default) → archiver, keep every write
//   GAVL_PERSIST=mine            → keep only writes touching my wallet keys + their coins
const PERSIST = process.env.GAVL_PERSIST ?? "all";

// Channel/network: the name IS the address (a plain label). GAVL_NETWORK sets the initial channel;
// the UI can switch at runtime. MESH/FARM gate consensus.
const NETWORK = process.env.GAVL_NETWORK ?? "gavl-testnet";
const MESH = process.env.GAVL_MESH !== "0";
const FARM = process.env.GAVL_FARM !== "0";

// Networking is Nostr over public relays: outbound WSS only, so there is no local port to probe and
// nothing to install. The daemon fails LOUD (and exits) if it can't reach any relay — see joinMesh.

// GAVL_DATA_DIR isolates a node's wallet + producer key — REQUIRED to run several nodes on one box.
const DATA_DIR = process.env.GAVL_DATA_DIR; // undefined → ~/.gavl

const daemon = new Daemon({
	params: defaultParams(),
	network: NETWORK,
	walletDir: DATA_DIR,
	space: SPACE,
	// Plot-size exponent. The stand-in prover uses 11; real chiapos requires k>=18 or
	// plotting throws, so chiapos defaults to 18 (no need to remember GAVL_K). Override
	// with GAVL_K for a bigger plot (more disk + higher anchor win-rate); it's created
	// once and reused from the plot dir.
	k: process.env.GAVL_K ? Number(process.env.GAVL_K) : SPACE === "chiapos" ? 18 : 11,
	schedule: RETARGET ? { base: 20n, targetIters: TARGET_ITERS, epoch: 4, window: 8, maxStep: 4n } : undefined,
	heartbeatMs: HEARTBEAT_MS,
	store: PERSIST === "off" ? undefined : { dir: DATA_DIR ? `${DATA_DIR}/store` : undefined, persist: PERSIST === "mine" ? "mine" : "all" },
	// Replication floor: warn when fewer than this many distinct nodes hold the latest checkpoint,
	// so RAM state stays durable across churn. Default 1 (off); set to your archiver count.
	replicationTarget: Number(process.env.GAVL_REPLICATION_TARGET ?? "1"),
});

// ── local fleet: up/down extra independent nodes on this machine, driven by the UI stepper ───────
// The daemon supervises child node processes. Each is a FULL independent farmer — its own data dir,
// API port, identity, and auto-plotted k=18 plot (real PoST weight). One plot ⇄ one producer key
// (Sybil-bound), so extra nodes add weight only by committing real disk; capped because each costs
// real disk + CPU. They're torn down with the supervisor so they never outlive it.
const FLEET_CAP = Number(process.env.GAVL_FLEET_CAP ?? 6);
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
type FleetNodeState = { address: string | null; tip: number | null; peers: number; producing: boolean; farming: boolean };
const fleet: { name: string; port: number; child: ReturnType<typeof spawn>; startedAt: number; state?: FleetNodeState | null }[] = [];
let fleetSeq = 0;

function freeFleetPort(start = 6450): Promise<number> {
	const probe = (p: number): Promise<number> =>
		fleet.some((f) => f.port === p)
			? probe(p + 1)
			: new Promise<number>((resolve) => {
					const s = netServer();
					s.once("error", () => resolve(probe(p + 1)));
					s.once("listening", () => s.close(() => resolve(p)));
					s.listen(p, "127.0.0.1");
				});
	return probe(start);
}

async function fleetUp(): Promise<void> {
	if (fleet.length >= FLEET_CAP) throw new Error(`local fleet cap reached (${FLEET_CAP}); each node is real disk + CPU`);
	const name = `node-${++fleetSeq}`;
	const port = await freeFleetPort();
	const env = { ...process.env };
	env.GAVL_DATA_DIR = join(homedir(), ".gavl-nodes", name);
	env.GAVL_PORT = String(port);
	const child = spawn(process.execPath, [join(REPO_ROOT, "src", "server.ts")], { cwd: REPO_ROOT, stdio: "ignore", windowsHide: true, env });
	const entry = { name, port, child, startedAt: Date.now() };
	const drop = () => { const i = fleet.indexOf(entry); if (i >= 0) fleet.splice(i, 1); };
	child.on("exit", drop);
	child.on("error", drop);
	fleet.push(entry);
}

function fleetDown(): void {
	const entry = fleet.pop();
	if (entry) try { entry.child.kill(); } catch { /* already gone */ }
}

function fleetStatus(): { count: number; cap: number; nodes: { name: string; port: number; upSec: number; state: FleetNodeState | null }[] } {
	const now = Date.now();
	return { count: fleet.length, cap: FLEET_CAP, nodes: fleet.map((f) => ({ name: f.name, port: f.port, upSec: Math.round((now - f.startedAt) / 1000), state: f.state ?? null })) };
}

// Poll each child's API so the UI carousel can show its live identity + status. Cached (non-blocking
// to /api/state) and best-effort — a child that's still plotting / sluggish just keeps its last value.
async function pollFleet(): Promise<void> {
	await Promise.all(
		fleet.map(async (f) => {
			try {
				const r = await fetch(`http://127.0.0.1:${f.port}/api/state`, { signal: AbortSignal.timeout(3000) });
				const d = (await r.json()) as { consensus?: { nodeKey?: string; tip?: { height?: number }; peers?: number; iProduce?: boolean; farming?: boolean } };
				const c = d.consensus ?? {};
				f.state = { address: c.nodeKey ?? null, tip: c.tip?.height ?? null, peers: c.peers ?? 0, producing: !!c.iProduce, farming: !!c.farming };
			} catch {
				/* keep the last known state */
			}
		}),
	);
}
const fleetPoll = setInterval(() => void pollFleet(), 2500);
if (typeof fleetPoll.unref === "function") fleetPoll.unref();

const killFleet = (): void => { for (const f of fleet) try { f.child.kill(); } catch { /* ignore */ } };
process.on("exit", killFleet);
process.on("SIGINT", () => { killFleet(); process.exit(0); });
process.on("SIGTERM", () => { killFleet(); process.exit(0); });

// ── state → JSON ─────────────────────────────────────────────────

function serializeState() {
	const accounts = daemon.wallet.list().map((a) => ({ label: a.label, pubHex: a.pubHex }));
	return { accounts, active: daemon.wallet.active().pubHex, consensus: daemon.consensus(), storage: daemon.storeStats(), fleet: fleetStatus() };
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

	if (method === "GET" && path === "/api/events") {
		const since = Number(url.searchParams.get("since") ?? "0") || 0;
		return send(res, 200, daemon.events(since));
	}

	if (method === "GET" && path === "/api/offers") {
		return send(res, 200, daemon.offers());
	}

	if (method === "GET" && path === "/api/matches") {
		return send(res, 200, daemon.matches(url.searchParams.get("mine") === "1"));
	}

	if (method === "POST") {
		const body = await readBody(req);

		// ── order board (ops are posted by the ACTIVE identity; each pays a write's PoST cooldown) ──
		if (path === "/api/offer") {
			const expiresIn = body.expiresIn === undefined ? undefined : Number(body.expiresIn);
			return send(res, 200, await daemon.postOffer({ give: body.give, want: body.want, minFill: body.minFill, expiresIn }));
		}
		if (path === "/api/take") {
			return send(res, 200, await daemon.takeOffer(String(body.offerId ?? ""), String(body.fill ?? "")));
		}
		if (path === "/api/cancel") {
			return send(res, 200, await daemon.cancelOffer(String(body.offerId ?? "")));
		}
		if (path === "/api/accounts") {
			const acct = daemon.createAccount(String(body.label ?? "account"));
			return send(res, 200, { pubHex: acct.pubHex });
		}
		if (path === "/api/accounts/active") {
			daemon.wallet.setActive(String(body.pubHex));
			return send(res, 200, { active: body.pubHex });
		}
		if (path === "/api/channel") {
			// Join a different channel by name. Each channel is its own network (own anchor
			// chain + ledger state); your wallet/identity is shared. Returns once the switch lands.
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
			// Pin a peer by its nostr pubkey (hex); re-pinned every boot (eclipse resistance).
			daemon.dialPeer(String(body.key ?? ""), body.pin !== false);
			return send(res, 200, { pinned: daemon.pinnedPeers() });
		}
		if (path === "/api/peers/unpin") {
			daemon.unpinPeer(String(body.key ?? ""));
			return send(res, 200, { pinned: daemon.pinnedPeers() });
		}
		if (path === "/api/gossip-interval") {
			// Live-tune the re-announce (discovery gossip) cadence in seconds; the sidecar adopts it now.
			const secs = Number(body.seconds);
			if (!Number.isFinite(secs) || secs < 1) throw new Error("seconds must be a number ≥ 1");
			daemon.setGossipInterval(secs);
			return send(res, 200, { ok: true });
		}
		if (path === "/api/fleet/up") {
			// Spin up one more independent local node (own data dir, port, identity, k=18 plot).
			await fleetUp();
			return send(res, 200, fleetStatus());
		}
		if (path === "/api/fleet/down") {
			// Stop the most-recently-spawned local node.
			fleetDown();
			return send(res, 200, fleetStatus());
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

	await daemon.startConsensus({ network: NETWORK, mesh: MESH, farm: FARM });
	const c = daemon.consensus();
	console.log(`  → mesh ${c.mesh ? "joined" : "off"}, ${c.peers} peer(s), farming ${c.farming ? "live" : "off"}`);
});

process.on("SIGINT", async () => {
	await daemon.stop();
	process.exit(0);
});
