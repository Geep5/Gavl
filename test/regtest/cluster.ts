/**
 * A full local Gavl swap network for end-to-end tests: one in-memory Nostr relay, Bitcoin Core and
 * Litecoin Core regtest nodes, an Esplora shim per chain, a background miner, and N daemon
 * PROCESSES of src/server.ts wired to all of them.
 *
 *   const c = await SwapCluster.start({ n: 3, nodeEnv: [{}, {}, { GAVL_SWAP_ENGINE: "nolock" }] });
 *   await c.daemons[1].kill();          // SIGKILL — a crash, not a clean stop
 *   await c.daemons[1].start();         // same data dir, same API port
 *   await c.stop();
 *
 * Each daemon has its own data dir (wallet, producer key, nostr identity, write store, swap files)
 * under the run dir, so a restart is the same node coming back. stdout+stderr of every start go to
 * <runDir>/node-i.log (appended, a banner per start). Fast anchors: hash VDF, stand-in space,
 * constant difficulty, 3 s heartbeat / peer pace.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROOT } from "../../scripts/regtest/releases.ts";
import type { SwapInfo } from "../../src/swap/engine.ts";
import type { CanonMatch, CanonOffer } from "../../src/market/state.ts";
import type { WalletInfo } from "../../src/daemon.ts";
import { RegtestNode, satsToCoins, type Chain } from "./node.ts";
import { startEsploraShim, type EsploraShim } from "./esplora-shim.ts";
import { startRelay, type LocalRelay } from "./relay.ts";

export const CHAINS: Chain[] = ["bitcoin", "litecoin"];

async function freePort(): Promise<number> {
	const srv = createServer().unref().listen(0, "127.0.0.1");
	await once(srv, "listening");
	const addr = srv.address();
	srv.close();
	await once(srv, "close");
	if (!addr || typeof addr !== "object") throw new Error("could not allocate a free port");
	return addr.port;
}

/** Poll `probe` until it returns a non-undefined value; throws on timeout with the last error. */
export async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs: number, everyMs = 500): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	for (;;) {
		try {
			const v = await probe();
			if (v !== undefined) return v;
		} catch (e) {
			lastErr = e;
		}
		if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}${lastErr ? ` (last error: ${(lastErr as Error).message})` : ""}`);
		await sleep(everyMs);
	}
}

/**
 * Litecoin regtest: MWEB activates at height 432 and the first HogEx needs a peg-in, or block
 * assembly fails (bad-txns-vin-empty) — see test/regtest/swap.test.ts activateLitecoinCsvAndMweb.
 * Mine to 431, peg in from a separate wallet, mine the activation block.
 */
export async function activateLitecoinMweb(node: RegtestNode): Promise<void> {
	const height = await node.rpc<number>("getblockcount");
	if (height >= 432) return;
	await node.mine(431 - height);
	await node.rpc("createwallet", ["mweb-sink"]);
	const mwebAddr = await node.rpc<string>("getnewaddress", ["", "mweb"], "mweb-sink");
	await node.walletRpc("sendtoaddress", [mwebAddr, "1.0"]);
	await node.mine(1);
}

const live = new Set<ChildProcess>();
process.once("exit", () => {
	for (const p of live) p.kill("SIGKILL");
});

/** The slice of GET /api/state the harness reads. */
export interface NodeState {
	active: string;
	accounts: { label: string; pubHex: string }[];
	consensus: { tip: { height: number } | null; peers: number };
}

/** One daemon process (src/server.ts) with a stable data dir + API port across restarts. */
export class DaemonProc {
	readonly name: string;
	readonly port: number;
	readonly dataDir: string;
	readonly logPath: string;
	private readonly env: Record<string, string>;
	private proc: ChildProcess | null = null;
	private starts = 0;

	constructor(index: number, port: number, runDir: string, env: Record<string, string>) {
		this.name = `node-${index}`;
		this.port = port;
		this.dataDir = path.join(runDir, this.name);
		this.logPath = path.join(runDir, `${this.name}.log`);
		this.env = env;
		mkdirSync(this.dataDir, { recursive: true });
	}

	get alive(): boolean {
		return this.proc !== null;
	}

	get url(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Spawn the daemon and wait until its API answers. */
	async start(readyTimeoutMs = 60_000): Promise<void> {
		if (this.proc) throw new Error(`${this.name} already running`);
		const fd = openSync(this.logPath, "a");
		writeSync(fd, `\n===== ${this.name} start #${++this.starts} at ${new Date().toISOString()} =====\n`);
		const proc = spawn(process.execPath, [path.join(ROOT, "src", "server.ts")], {
			cwd: ROOT,
			env: { ...process.env, ...this.env, GAVL_DATA_DIR: this.dataDir, GAVL_PORT: String(this.port) },
			stdio: ["ignore", fd, fd],
		});
		closeSync(fd);
		this.proc = proc;
		live.add(proc);
		proc.once("exit", () => {
			live.delete(proc);
			if (this.proc === proc) this.proc = null;
		});
		await waitFor(
			async () => {
				if (this.proc !== proc) throw new Error(`${this.name} exited during startup\n${this.tail(30)}`);
				const r = await fetch(`${this.url}/api/state`, { signal: AbortSignal.timeout(2000) });
				return r.ok ? true : undefined;
			},
			`${this.name} API`,
			readyTimeoutMs,
			250,
		);
	}

	/** SIGKILL (no shutdown hooks run). */
	async kill(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null;
		const exited = once(proc, "exit");
		proc.kill("SIGKILL");
		await exited;
	}

	tail(n = 40): string {
		return existsSync(this.logPath) ? readFileSync(this.logPath, "utf8").split("\n").slice(-n).join("\n") : "";
	}

	async api<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
		const r = await fetch(`${this.url}${route}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const json = (await r.json()) as T & { error?: string };
		if (!r.ok) throw new Error(`${this.name} ${method} ${route}: HTTP ${r.status} ${json.error ?? ""}`);
		return json;
	}

	state(): Promise<NodeState> {
		return this.api("GET", "/api/state", undefined, 5000);
	}

	async wallets(): Promise<Record<Chain, WalletInfo>> {
		const { wallets } = await this.api<{ wallets: WalletInfo[] }>("GET", "/api/wallets");
		return Object.fromEntries(wallets.map((w) => [w.chain, w])) as Record<Chain, WalletInfo>;
	}

	async swaps(): Promise<SwapInfo[]> {
		return (await this.api<{ swaps: SwapInfo[] }>("GET", "/api/swaps", undefined, 5000)).swaps;
	}

	async swap(matchId: string): Promise<SwapInfo | undefined> {
		return (await this.swaps()).find((s) => s.matchId === matchId);
	}

	async offers(): Promise<CanonOffer[]> {
		return (await this.api<{ offers: CanonOffer[] }>("GET", "/api/offers", undefined, 5000)).offers;
	}

	async matches(): Promise<CanonMatch[]> {
		return (await this.api<{ matches: CanonMatch[] }>("GET", "/api/matches", undefined, 5000)).matches;
	}

	async postOffer(give: { chain: Chain; amount: bigint }, want: { chain: Chain; amount: bigint }): Promise<string> {
		const r = await this.api<{ offerId: string }>("POST", "/api/offer", {
			give: { chain: give.chain, amount: give.amount.toString() },
			want: { chain: want.chain, amount: want.amount.toString() },
			minFill: give.amount.toString(),
		});
		return r.offerId;
	}

	async take(offerId: string, fill: bigint): Promise<string> {
		return (await this.api<{ matchId: string }>("POST", "/api/take", { offerId, fill: fill.toString() })).matchId;
	}
}

/** Mines a block on every chain every `intervalMs`, unless paused. */
export class Miner {
	private readonly nodes: RegtestNode[];
	private readonly addrs = new Map<RegtestNode, string>();
	private timer?: NodeJS.Timeout;
	private paused = false;
	private busy: Promise<void> = Promise.resolve();

	constructor(nodes: RegtestNode[]) {
		this.nodes = nodes;
	}

	start(intervalMs: number): void {
		this.timer = setInterval(() => {
			if (!this.paused) void this.mine(1).catch(() => {});
		}, intervalMs);
	}

	/** Stop the background blocks (waits for one in progress). */
	async pause(): Promise<void> {
		this.paused = true;
		await this.busy;
	}

	resume(): void {
		this.paused = false;
	}

	/** Mine `n` blocks now on `chain` (default: every chain). Serialized with the background blocks. */
	mine(n: number, chain?: Chain): Promise<void> {
		const run = async () => {
			for (const node of this.nodes) {
				if (chain && node.chain !== chain) continue;
				let addr = this.addrs.get(node);
				if (!addr) this.addrs.set(node, (addr = await node.newAddress()));
				await node.mine(n, addr);
			}
		};
		const p = this.busy.then(run, run);
		this.busy = p.catch(() => {});
		return p;
	}

	async stop(): Promise<void> {
		clearInterval(this.timer);
		await this.busy;
	}
}

export interface SwapClusterOptions {
	n: number;
	/** Extra env for every daemon. */
	env?: Record<string, string>;
	/** Extra env per daemon index. */
	nodeEnv?: Record<string, string>[];
	/** Background block interval (ms). Default 2000. */
	blockMs?: number;
}

export class SwapCluster {
	readonly runDir: string;
	readonly relay: LocalRelay;
	readonly nodes: Record<Chain, RegtestNode>;
	readonly shims: Record<Chain, EsploraShim>;
	readonly daemons: DaemonProc[];
	readonly miner: Miner;

	private constructor(p: { runDir: string; relay: LocalRelay; nodes: Record<Chain, RegtestNode>; shims: Record<Chain, EsploraShim>; daemons: DaemonProc[]; miner: Miner }) {
		this.runDir = p.runDir;
		this.relay = p.relay;
		this.nodes = p.nodes;
		this.shims = p.shims;
		this.daemons = p.daemons;
		this.miner = p.miner;
	}

	static daemonEnv(network: string, relayUrl: string, shims: Record<Chain, EsploraShim>): Record<string, string> {
		return {
			GAVL_NETWORK: network,
			GAVL_RELAYS: relayUrl,
			GAVL_BTC_NET: "regtest",
			GAVL_LTC_NET: "regtest",
			GAVL_BTC_ESPLORA_URL: shims.bitcoin.url,
			GAVL_LTC_ESPLORA_URL: shims.litecoin.url,
			GAVL_VDF: "hash",
			GAVL_SPACE: "standin",
			GAVL_PERSIST: "all",
			GAVL_RETARGET: "0", // constant difficulty: the pace knobs below set the anchor cadence
			GAVL_HEARTBEAT_MS: "3000",
			GAVL_PEER_PACE_MS: "3000",
			GAVL_ANNOUNCE_INTERVAL: "5",
			GAVL_LIVE_PEER_MS: "30000",
			GAVL_SWAP_TICK_MS: "1500",
		};
	}

	static async start(o: SwapClusterOptions): Promise<SwapCluster> {
		const runDir = mkdtempSync(path.join(tmpdir(), "gavl-e2e-"));
		const network = `gavl-e2e-${Date.now().toString(36)}`;
		const relay = await startRelay();
		const nodes = {} as Record<Chain, RegtestNode>;
		const shims = {} as Record<Chain, EsploraShim>;
		const daemons: DaemonProc[] = [];
		try {
			const started = await Promise.allSettled(CHAINS.map((c) => RegtestNode.start(c)));
			for (const r of started) if (r.status === "fulfilled") nodes[r.value.chain] = r.value;
			const failed = started.find((r) => r.status === "rejected");
			if (failed) throw (failed as PromiseRejectedResult).reason;
			await activateLitecoinMweb(nodes.litecoin);
			for (const c of CHAINS) shims[c] = await startEsploraShim(nodes[c]);
			const env = { ...SwapCluster.daemonEnv(network, relay.url, shims), ...o.env };
			for (let i = 0; i < o.n; i++) daemons.push(new DaemonProc(i, await freePort(), runDir, { ...env, ...o.nodeEnv?.[i] }));
			await Promise.all(daemons.map((d) => d.start()));
			const miner = new Miner(CHAINS.map((c) => nodes[c]));
			miner.start(o.blockMs ?? 2000);
			return new SwapCluster({ runDir, relay, nodes, shims, daemons, miner });
		} catch (e) {
			await Promise.all(daemons.map((d) => d.kill()));
			for (const s of Object.values(shims)) await s.close();
			await Promise.all(Object.values(nodes).map((n) => n.stop()));
			await relay.close();
			throw e;
		}
	}

	/** Pay `amount` base units from the chain node's wallet to `address` (confirmed by the miner). */
	async fund(chain: Chain, address: string, amount: bigint): Promise<string> {
		return this.nodes[chain].walletRpc<string>("sendtoaddress", [address, satsToCoins(amount)]);
	}

	/** The fee of `txid` as the explorer reports it. */
	async fee(chain: Chain, txid: string): Promise<bigint> {
		const r = await fetch(`${this.shims[chain].url}/tx/${txid}`);
		if (!r.ok) throw new Error(`shim ${chain} tx ${txid}: HTTP ${r.status}`);
		const tx: { fee?: unknown } = await r.json();
		if (typeof tx.fee !== "number") throw new Error(`shim ${chain} tx ${txid}: no fee`);
		return BigInt(tx.fee);
	}

	tails(n = 60): string {
		return this.daemons.map((d) => `──── ${d.name} (${d.alive ? "alive" : "down"}) ${d.logPath} ────\n${d.tail(n)}`).join("\n");
	}

	/** Kill every daemon, stop the miner, shims, nodes and relay. Keeps the run dir (logs) unless `removeRunDir`. */
	async stop(removeRunDir = false): Promise<void> {
		await this.miner.stop();
		await Promise.all(this.daemons.map((d) => d.kill()));
		for (const s of Object.values(this.shims)) await s.close();
		await Promise.all(Object.values(this.nodes).map((n) => n.stop()));
		await this.relay.close();
		if (removeRunDir) rmSync(this.runDir, { recursive: true, force: true });
	}
}
