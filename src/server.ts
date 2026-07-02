/**
 * HTTP+JSON API for the web UI — a thin control surface over the Daemon.
 *
 * Localhost only. No deps (Node's http). All amounts are strings (BigInt-safe).
 * Writes pay the PoST cooldown, so action endpoints are async and can take a
 * few hundred ms.
 *
 *   GET  /api/state                       → { accounts, active, coins, balances }
 *   POST /api/accounts        {label}      → create + activate an identity
 *   POST /api/accounts/active {pubHex}     → switch the active identity
 *   POST /api/coins           {name,symbol,supply}        → deploy a coin
 *   POST /api/transfer        {token,to,amount}
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer as netServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Daemon, parseChannel, defaultMarketChannel } from "./daemon.ts";
import { genesisCommitteeKey } from "./custody/genesis-committee.ts";
import { mark, gbtcOf, parseAmount } from "./market/btc.ts";
import { roundIdxAt, lockBoundary, closeBoundary, entryOpen, roundsEscrowTotal, ROUND_LEN, MIN_ROUND_STAKE } from "./market/rounds.ts";
import type { RoundSide } from "./market/rounds.ts";
import type { View } from "./market/btc.ts";
import { totalGbtc, pendingTotal } from "./custody/bridge.ts";

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

// Channel/network: the name IS the address. GAVL_NETWORK sets the initial channel; the UI can
// switch at runtime. MESH/FARM gate consensus. Default is the shipped BTC-USD market channel (name
// encodes a Pyth feed id), so the app prices + trades out of the box; a plain GAVL_NETWORK name = a
// transfers-only channel.
const NETWORK = process.env.GAVL_NETWORK ?? defaultMarketChannel();
const MESH = process.env.GAVL_MESH !== "0";
const FARM = process.env.GAVL_FARM !== "0";

// DIAGNOSTIC (2): Gavl networks ONLY over Reticulum (RNS/LXMF via a Python sidecar). Fail FAST + LOUD
// if those modules can't be imported, instead of silently degrading to a mesh-less "local" node —
// the exact "why won't it connect" trap. Skipped only when the mesh is intentionally off.
if (MESH) {
	const py = process.env.GAVL_PYTHON ?? "python";
	const probe = spawnSync(py, ["-c", "import RNS, LXMF"], { stdio: "ignore" });
	if (probe.status !== 0) {
		console.error(`\n✗ Reticulum networking needs the Python RNS + LXMF modules, but \`${py} -c "import RNS, LXMF"\` failed.`);
		console.error("  Install them once:          pip install rns lxmf");
		console.error("  Wrong Python? point at it:  GAVL_PYTHON=python3 npm run dev");
		console.error("  Intentional local node:     GAVL_MESH=0 npm run dev\n");
		process.exit(1);
	}
}

// Threshold custody — there is ONLY one mode: an M-of-N committee. A DKG at genesis, reshare each
// epoch, and NO node ever holds the key. A node won't custody until ≥minCommittee farmers form the
// committee, so a LONE node has no fund and WAITS for peers — it never falls back to a single key, on
// any network. (Solo/seed mode was removed entirely.) GAVL_DATA_DIR isolates a node's wallet +
// custody secrets — REQUIRED to run several nodes on one box.
if (process.env.GAVL_CUSTODY && process.env.GAVL_CUSTODY !== "committee")
	console.warn(`  note: GAVL_CUSTODY=${process.env.GAVL_CUSTODY} ignored — committee is the only custody mode (solo/seed was removed; a lone node waits for peers).`);
const BTC_NET = process.env.GAVL_BTC_NET === "mainnet" ? "mainnet" : process.env.GAVL_BTC_NET === "signet" ? "signet" : "testnet";
const DATA_DIR = process.env.GAVL_DATA_DIR; // undefined → ~/.gavl

// Mainnet safety-lock: custody is already committee-only (no single-key path can arise), but real BTC
// must also never live only in RAM — a restart would erase who owns which BTC. Refuse in-memory on
// mainnet. Testnet/signet are free to do as they like.
if (BTC_NET === "mainnet" && PERSIST === "off")
	throw new Error("mainnet refuses in-memory storage (GAVL_PERSIST=off) — a restart would erase who owns which BTC. Use GAVL_PERSIST=all on durable disk.");

const daemon = new Daemon({
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
	custody: {
		epochLength: Number(process.env.GAVL_CUSTODY_EPOCH ?? "16"),
		size: Number(process.env.GAVL_CUSTODY_SIZE ?? "5"),
		minCommittee: Number(process.env.GAVL_CUSTODY_MIN ?? "3"),
		ceremonyTimeoutMs: Number(process.env.GAVL_CUSTODY_TIMEOUT_MS ?? "30000"),
		bonded: process.env.GAVL_CUSTODY_BONDED === "1", // gate #3: stake-weight selection by bonded gBTC
	},
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
	delete env.GAVL_RNS_CONFIG; // each fleet node writes/uses its OWN default config in its data dir
	env.GAVL_DATA_DIR = join(homedir(), ".gavl-nodes", name);
	env.GAVL_PORT = String(port);
	env.GAVL_ORACLE_PUBLISH = "0";
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

// ── Gavl Rounds → JSON (the 1-click bull/bear panel + agent API) ──

/** A round as the client sees it. Synthesized from the height geometry even when nobody has entered
 *  yet (a round with no entries doesn't exist in consensus state — but the CLOCK always does). */
interface RoundInfo {
	idx: number;
	locksAt: number; // strike boundary (anchor height)
	closesAt: number; // settle boundary
	strike: string | null;
	poolUp: string; // TOTAL depth: entry stakes + the pot's lock-time seed (odds/payouts run on totals)
	poolDown: string;
	seeded: string; // the pot's seed in this round (seedUp + seedDown) — 0 until lock, badge-able
	entries: number;
	mySide: RoundSide | null;
	myStake: string;
}

/** Recently-ended rounds (the history strip): kept by this server process by diffing polls — a
 *  best-effort UI nicety (resets on restart; the chain is the authority). `close` = the mark at
 *  detection; payouts recompute exactly from the cached pools. */
const roundsHistory: { idx: number; strike: string | null; close: string | null; outcome: "up" | "down" | "refund"; mySide: RoundSide | null; myStake: string; myPayout: string }[] = [];
let lastRoundsSeen = new Map<number, { strike: bigint | null; poolUp: bigint; poolDown: bigint; mySide: RoundSide | null; myStake: bigint }>();

function roundInfoOf(view: View, me: string, idx: number): RoundInfo {
	const r = view.rounds.get(idx);
	const mine = r?.entries.get(me);
	return {
		idx,
		locksAt: lockBoundary(idx),
		closesAt: closeBoundary(idx),
		strike: r?.strike?.toString() ?? null,
		poolUp: ((r?.poolUp ?? 0n) + (r?.seedUp ?? 0n)).toString(), // totals — real settleable depth
		poolDown: ((r?.poolDown ?? 0n) + (r?.seedDown ?? 0n)).toString(),
		seeded: ((r?.seedUp ?? 0n) + (r?.seedDown ?? 0n)).toString(),
		entries: r?.entries.size ?? 0,
		mySide: mine?.side ?? null,
		myStake: (mine?.stake ?? 0n).toString(),
	};
}

/** The rounds block: the accepting round, the live (locked) one, constants, and recent history. */
function roundsInfo(view: View, me: string, tipHeight: number) {
	// Track endings: a cached round that vanished from state settled (or refunded). Outcome derives
	// from its strike vs the current mark; payouts recompute exactly from the cached pools.
	const nowSeen = new Map<number, { strike: bigint | null; poolUp: bigint; poolDown: bigint; mySide: RoundSide | null; myStake: bigint }>();
	for (const [idx, r] of view.rounds) {
		const mine = r.entries.get(me);
		// Cache TOTAL pools (stakes + pot seed) — settle runs on totals, so the payout recompute stays exact.
		nowSeen.set(idx, { strike: r.strike, poolUp: r.poolUp + r.seedUp, poolDown: r.poolDown + r.seedDown, mySide: mine?.side ?? null, myStake: mine?.stake ?? 0n });
	}
	const closeMark = view.market.price;
	for (const [idx, r] of lastRoundsSeen) {
		if (nowSeen.has(idx)) continue;
		const refunded = r.strike === null || r.poolUp === 0n || r.poolDown === 0n || closeMark === null || closeMark === r.strike;
		const outcome: "up" | "down" | "refund" = refunded ? "refund" : closeMark! > r.strike! ? "up" : "down";
		let myPayout = 0n;
		if (r.myStake > 0n) {
			if (outcome === "refund") myPayout = r.myStake;
			else if (r.mySide === outcome) {
				const losePool = outcome === "up" ? r.poolDown : r.poolUp;
				const winPool = outcome === "up" ? r.poolUp : r.poolDown;
				myPayout = r.myStake + (r.myStake * losePool) / winPool; // pure parimutuel: the whole losing pool distributes
			}
		}
		roundsHistory.unshift({ idx, strike: r.strike?.toString() ?? null, close: closeMark?.toString() ?? null, outcome, mySide: r.mySide, myStake: r.myStake.toString(), myPayout: myPayout.toString() });
	}
	if (roundsHistory.length > 20) roundsHistory.length = 20;
	lastRoundsSeen = nowSeen;

	const enteringIdx = roundIdxAt(tipHeight);
	return {
		len: ROUND_LEN,
		minStake: MIN_ROUND_STAKE.toString(),
		tip: tipHeight,
		entryOpen: entryOpen(enteringIdx, tipHeight), // false during the pre-lock cutoff anchor
		entering: roundInfoOf(view, me, enteringIdx),
		live: enteringIdx > 0 ? roundInfoOf(view, me, enteringIdx - 1) : null, // closes exactly when `entering` locks
		history: roundsHistory.slice(0, 12),
	};
}

// ── View → JSON (Maps + BigInts → plain, string amounts) ─────────

function serializeState() {
	const view = daemon.view(); // optimistic tip — reflects actions immediately
	const me = daemon.wallet.active().pubHex;
	const m = mark(view); // this channel's market price, null until a Pyth update is relayed

	// gBTC balances: { pubkey: amount } (1:1 claims on BTC in the custody fund)
	const gbtc: Record<string, string> = {};
	for (const [pubkey, amt] of view.bridge.gbtc) gbtc[pubkey] = amt.toString();

	// A CHANNEL IS A MARKET, named by its price source: `label::pyth::feedId` (a Wormhole-attested Pyth
	// feed, 13-of-19 guardians) or `label::signed::setHash` (any M-of-N Ed25519 signer set you stand up).
	// Either way ANYONE may relay a quorum-signed update — the fold verifies the quorum, so there's no
	// reporter to trust and no single signer can forge. Each channel is its own sandboxed economy.
	const def = parseChannel(daemon.currentChannel());
	const live = def ? daemon.oracleSource() : null;
	const marketInfo = def
		? {
				channel: daemon.currentChannel(),
				kind: def.kind, // "pyth" | "signed"
				label: def.label,
				feedId: def.kind === "pyth" ? def.feedId : null, // Pyth feed id (pyth markets)
				signerSet: def.kind === "signed" ? def.signerSet : null, // committed signer-set hash (signed markets)
				price: m != null ? m.toString() : null,
				iAmRelaying: !!live, // this node is relaying the feed (anyone may; the quorum signature is the authority)
				source: live ? { method: live.method, ageMs: Date.now() - live.at, feeds: live.readings.map((r) => ({ endpoint: r.endpoint, key: r.key, raw: r.raw, value: r.value != null ? r.value.toString() : null, error: r.error ?? null })) } : null,
			}
		: null;

	const consensus = daemon.consensus(); // hoisted: the rounds clock needs the tip height
	const tipH = Number(consensus?.tip?.height ?? 0);
	const rsv = daemon.onChainReservesCached(); // proof-of-reserves reading (cached, polled)
	const onChainR = rsv != null ? rsv.sats : null;
	// Idle-SWEEP (demurrage) countdown for the active account: a free balance is swept WHOLE to the pot
	// at its idle deadline (`charged` = last-credit + grace) — a flat timeout, not a decay. The UI turns
	// this single height into a live countdown via the current tip. Null if the account has no balance/clock.
	const cf = view.bridge.chargeFrom.get(me);
	const idleDecay = cf ? { sweepAtHeight: cf.charged } : null;
	// Conservation buckets (reserves == free + bonded + pending + pot + rounds) for the UI breakdown.
	// `free` is the remainder, so the five always sum to reserves regardless of how the ledger rounds.
	const roundsV = roundsEscrowTotal(view.rounds);
	const bondedV = [...view.bridge.bonds.values()].reduce((a, b) => a + b, 0n);
	const freeV = view.bridge.reserves - bondedV - pendingTotal(view.bridge) - view.bridge.pot - roundsV;
	const market = {
		oracle: def?.kind ?? "pyth", // mechanism: the channel name encodes the price source; updates are source-signed
		marketInfo,
		price: m != null ? m.toString() : null,
		priceExpo: view.market.expo, // decimal exponent: display value = price · 10^expo
		// collateral = gBTC, a 1:1 claim on BTC in the custody fund
		myGbtc: gbtcOf(view, me).toString(),
		idleDecay, // { sweepAtHeight } | null — idle-sweep countdown for your idle gBTC (flat timeout)

		reserves: view.bridge.reserves.toString(), // BTC sats in the fund
		gbtcOutstanding: (totalGbtc(view.bridge) + roundsV).toString(),
		pending: pendingTotal(view.bridge).toString(), // burned, awaiting BTC payout
		pendingCount: view.bridge.pending.length,
		// YOUR OWN deposit address — derived from (fund key, your pubkey), so a deposit
		// here is cryptographically bound to you and can't be claimed by anyone else.
		depositAddress: daemon.depositAddressFor(me),
		fundAddress: daemon.fundAddress(), // base fund address (change/consolidation)
		btcNetwork: daemon.btcNetwork(),
		// proof of reserves: real on-chain BTC vs the ledger's claimed reserves
		onChainReserves: onChainR != null ? onChainR.toString() : null,
		reconciled: onChainR != null ? onChainR >= view.bridge.reserves : null, // real BTC covers the ledger?
		shortfall: onChainR != null ? (view.bridge.reserves > onChainR ? (view.bridge.reserves - onChainR).toString() : "0") : null,
		reservesCheckedAgoMs: rsv != null ? Date.now() - rsv.at : null,
		// ── the liquidity pot (fed by demurrage idle-sweeps + settle dust; outflow = pot-seeding at lock) ──
		pot: view.bridge.pot.toString(),
		// conservation breakdown (free + bonded + pending + pot + rounds == reserves)
		free: freeV.toString(),
		bonded: bondedV.toString(),
		roundsEscrow: roundsV.toString(),
		// ── Gavl Rounds: the 1-click bull/bear panel (accepting + live round, odds, history) ──
		rounds: roundsInfo(view, me, tipH),
	};

	const accounts = daemon.wallet.list().map((a) => ({ label: a.label, pubHex: a.pubHex }));
	return { accounts, active: me, gbtc, market, consensus, custody: daemon.custodyStatus(), storage: daemon.storeStats(), fleet: fleetStatus() };
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

	if (method === "GET" && path === "/api/rounds") {
		// The agent-facing rounds endpoint: same block the UI gets, without the rest of the state.
		return send(res, 200, roundsInfo(daemon.view(), daemon.wallet.active().pubHex, Number(daemon.consensus()?.tip?.height ?? 0)));
	}

	if (method === "GET" && path === "/api/events") {
		const since = Number(url.searchParams.get("since") ?? "0") || 0;
		return send(res, 200, daemon.events(since));
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
			// Burn gBTC to redeem BTC to a Bitcoin address → a pending withdrawal. `fee` (sats, optional)
			// is the withdrawer's chosen miner fee, deducted from their own payout. The protocol does NOT
			// cap it (broadcast what you want) — the sane upper bound is a UI guardrail; here we only
			// require a non-negative integer so it can build. Omit it to use the daemon default.
			if (!String(body.btcAddress ?? "").trim()) throw new Error("BTC address required");
			requireSpendable(String(body.amount), "amount");
			const feeStr = body.fee != null && String(body.fee).trim() !== "" ? String(body.fee) : undefined;
			if (feeStr !== undefined && !/^\d+$/.test(feeStr)) throw new Error("fee must be a non-negative integer (sats)");
			await daemon.active().withdraw(String(body.amount), String(body.btcAddress), feeStr);
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
		if (path === "/api/custody/bond") {
			// Lock gBTC at THIS node's committee identity as a bond (gate #3 stake weight).
			// Fund producerId() with a gbtc.transfer first.
			const amt = parseAmount(String(body.amount));
			if (amt === null) throw new Error("amount must be a positive integer");
			return send(res, 200, { id: await daemon.bondCustody(amt) });
		}
		if (path === "/api/custody/unbond") {
			const amt = parseAmount(String(body.amount));
			if (amt === null) throw new Error("amount must be a positive integer");
			return send(res, 200, { id: await daemon.unbondCustody(amt) });
		}
		if (path === "/api/market/test") {
			// Fetch-test a candidate Pyth feed before creating the market: fetch its latest update from
			// Hermes and verify the guardian-attested quorum + Merkle proof, returning the decoded price.
			const r = await daemon.testPythFeed(String(body.feedId ?? ""));
			return send(res, 200, r);
		}
		// ── Gavl Rounds: the 1-click bull/bear ──
		if (path === "/api/round/enter") {
			// Enter the current round's UP or DOWN pool (idx optional — agents may pin one). These are
			// UX guards only; the fold is authoritative and rejects the same conditions deterministically.
			const side = body.side === "up" ? "up" : body.side === "down" ? "down" : null;
			if (!side) throw new Error('side must be "up" or "down"');
			const stake = requireSpendable(String(body.stake), "stake");
			const tip = Number(daemon.consensus()?.tip?.height ?? 0);
			const idx = body.idx != null ? Number(body.idx) : roundIdxAt(tip);
			if (!Number.isInteger(idx) || idx < 0) throw new Error("idx must be a non-negative integer");
			if (!entryOpen(idx, tip)) throw new Error(`round #${idx} isn't accepting entries right now — entries close 1 anchor before lock; the next round opens at height ${lockBoundary(idx)}`);
			const mine = daemon.view().rounds.get(idx)?.entries.get(daemon.wallet.active().pubHex);
			if (!mine && stake < MIN_ROUND_STAKE) throw new Error(`minimum first entry is ${MIN_ROUND_STAKE} gBTC`);
			if (mine && mine.side !== side) throw new Error(`you're already ${mine.side.toUpperCase()} in round #${idx} — same side only (a re-entry tops up)`);
			const id = await daemon.active().enterRound(idx, side, stake);
			return send(res, 200, { id, idx, side, stake: stake.toString() });
		}
		if (path === "/api/channel") {
			// Join a different channel by name. Each channel is its own economy (own anchor
			// chain + market state); your wallet/identity is shared. Returns once the switch lands.
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
			// Pin + dial a peer by its LXMF address; re-dialed every boot (eclipse resistance).
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

	// Pricing: this node RELAYS the channel's Wormhole-attested Pyth feed (no reporter — anyone may;
	// the fold re-verifies). Opt out of relaying with GAVL_ORACLE_PUBLISH=0 (e.g. a node with no
	// internet); it then just consumes whatever peers relay.
	const publishOracle = process.env.GAVL_ORACLE_PUBLISH === "0" ? undefined : { everyMs: Number(process.env.GAVL_ORACLE_MS ?? "5000") };
	await daemon.startConsensus({ network: NETWORK, mesh: MESH, farm: FARM, publishOracle });
	const c = daemon.consensus();
	console.log(`  → mesh ${c.mesh ? "joined" : "off"}, ${c.peers} peer(s), farming ${c.farming ? "live" : "off"}`);
	const cu = daemon.custodyStatus();
	if (cu.fundKeyOnChain)
		console.log(`  custody: committee — fund ${cu.fundAddress} (key ${cu.fundKeyOnChain.slice(0, 12)}…; this node ${cu.holdsShare ? "holds a share" : "is watching"})`);
	else if (daemon.btcNetwork() !== "mainnet" && genesisCommitteeKey(daemon.currentChannel()) !== null)
		console.log(`  custody: trusted-dealer committee (testnet) — fund key publishing into the chain; finalizes once farming anchors it (no DKG). Repo holds only the public key.`);
	else
		console.log(`  custody: committee — WAITING for ≥${cu.minCommittee} farmers to run genesis DKG. No fund key yet, so minting is disabled until the committee forms — a lone node waits for peers; there is no single-key fallback.`);
});

process.on("SIGINT", async () => {
	await daemon.stop();
	process.exit(0);
});
