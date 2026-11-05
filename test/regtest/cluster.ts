/**
 * A full local Gavl network for multi-node tests: one in-memory Nostr relay, one Bitcoin Core
 * regtest node + Esplora shim, and N daemon PROCESSES of src/server.ts wired to them.
 *
 *   const cluster = await Cluster.start({ n: 5 });
 *   await cluster.nodes[2].kill();      // SIGKILL
 *   await cluster.nodes[2].restart();   // same data dir, same API port
 *   await cluster.stop();
 *
 * Each daemon gets its own data dir (wallet, producer key, custody share, nostr identity, and — with
 * persist "all" — its write store) under the run dir, so a restart is the same node coming back.
 * stdout+stderr of every start go to <runDir>/node-i.log (appended, with a banner per start).
 * Daemons run from a per-run COPY of src/ (Cluster.codeDir) so a node restarted mid-run runs the
 * same code as its peers even if the working tree changes meanwhile; `cluster.source` records it.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BIN_ROOT, ROOT } from "../../scripts/regtest/releases.ts";
import { RegtestNode } from "./node.ts";
import { startEsploraShim, type EsploraShim } from "./esplora-shim.ts";
import { startRelay, type LocalRelay } from "./relay.ts";

/** The slice of GET /api/state the harness reads (src/server.ts serializeState). */
export interface NodeState {
	active: string;
	gbtc: Record<string, string>;
	bridge: {
		myGbtc: string;
		reserves: string;
		gbtcOutstanding: string;
		pending: string;
		pendingCount: number;
		depositAddress: string | null;
		fundAddress: string | null;
		btcNetwork: string;
		onChainReserves: string | null;
	};
	consensus: {
		tip: { height: number; weight: string | number; id: string } | null;
		genesis: string | null;
		finalizedHeight: number | null;
		/** Newer daemons: settlement-depth height + whether a settled-height conflict was seen. */
		settledHeight?: number | null;
		settlementConflict?: unknown;
		peers: number;
		producers: number;
		iProduce: boolean;
		farming: boolean;
		nodeKey: string | null;
	};
	custody: {
		epoch: number;
		fundKeyOnChain: string | null;
		fundAddress: string | null;
		committeeId: string | null;
		holdsShare: boolean;
		committee: string[] | null;
		threshold: number | null;
		lastReshare?: { epoch: number; ok: boolean; detail: string };
		[extra: string]: unknown;
	};
}

export interface ClusterOptions {
	/** Number of daemon processes. */
	n: number;
	/** GAVL_COMMITTEE_MAX (K_MAX). Default n. */
	committeeMax?: number;
	/** GAVL_CUSTODY_MIN. Default 3. */
	minCommittee?: number;
	/** GAVL_CUSTODY_EPOCH (anchors per custody epoch). Default 24 (≈20–30 s at the harness pace). */
	epochLength?: number;
	/** GAVL_PERSIST: "all" = per-node write store under the node's data dir; "off" = RAM only. Default "all". */
	persist?: "all" | "off";
	/** Extra env for every daemon (overrides the harness defaults). */
	env?: Record<string, string>;
	/** Parent dir for the run dir. Default os.tmpdir(). */
	baseDir?: string;
	/** Run daemons from src/ at this git ref (e.g. "HEAD") instead of the working tree. */
	sourceRef?: string;
}

async function freePort(): Promise<number> {
	const srv = createServer().unref().listen(0, "127.0.0.1");
	await once(srv, "listening");
	const addr = srv.address();
	srv.close();
	await once(srv, "close");
	if (!addr || typeof addr !== "object") throw new Error("could not allocate a free port");
	return addr.port;
}

/** Poll `probe` until it returns a non-undefined value; throws `what` on timeout. */
export async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs: number, everyMs = 1000): Promise<T> {
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

const live = new Set<ChildProcess>();
process.once("exit", () => {
	for (const p of live) p.kill("SIGKILL");
});

/** One daemon process (src/server.ts) with a stable data dir + API port across restarts. */
export class DaemonProc {
	readonly index: number;
	readonly name: string;
	readonly port: number;
	readonly dataDir: string;
	readonly logPath: string;
	private readonly env: Record<string, string>;
	private readonly serverPath: string;
	private proc: ChildProcess | null = null;
	private starts = 0;
	/** Exits we did not cause (crash / process.exit) — each is evidence. */
	readonly unexpectedExits: { at: number; code: number | null; signal: string | null }[] = [];

	constructor(index: number, port: number, runDir: string, env: Record<string, string>, serverPath: string) {
		this.index = index;
		this.name = `node-${index}`;
		this.port = port;
		this.dataDir = path.join(runDir, this.name);
		this.logPath = path.join(runDir, `${this.name}.log`);
		this.env = env;
		this.serverPath = serverPath;
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
		const proc = spawn(process.execPath, [this.serverPath], {
			cwd: ROOT,
			env: { ...process.env, ...this.env, GAVL_DATA_DIR: this.dataDir, GAVL_PORT: String(this.port) },
			stdio: ["ignore", fd, fd],
		});
		closeSync(fd); // the child holds its own copy
		this.proc = proc;
		live.add(proc);
		proc.once("exit", (code, signal) => {
			live.delete(proc);
			if (this.proc === proc) {
				this.proc = null;
				this.unexpectedExits.push({ at: Date.now(), code, signal });
			}
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

	/** SIGKILL (no shutdown hooks run — a crash, not a clean stop). */
	async kill(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null; // an exit we caused
		const exited = once(proc, "exit");
		proc.kill("SIGKILL");
		await exited;
	}

	/** Same data dir, same port. */
	async restart(readyTimeoutMs?: number): Promise<void> {
		await this.kill();
		await this.start(readyTimeoutMs);
	}

	/** Last `n` lines of this node's log (all starts). */
	tail(n = 40): string {
		if (!existsSync(this.logPath)) return "";
		return readFileSync(this.logPath, "utf8").split("\n").slice(-n).join("\n");
	}

	/** Whole log (for scanning). */
	log(): string {
		return existsSync(this.logPath) ? readFileSync(this.logPath, "utf8") : "";
	}

	private async api<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
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

	/** GET /api/state */
	state(): Promise<NodeState> {
		return this.api("GET", "/api/state", undefined, 5_000);
	}

	/** The active account's per-user deposit address + pubkey (null address pre-genesis). */
	async depositAddress(): Promise<{ account: string; address: string | null }> {
		const s = await this.state();
		return { account: s.active, address: s.bridge.depositAddress };
	}

	/** POST /api/deposit/claim — posts the claim trigger for the active account; returns sats found. */
	async claimDeposit(txid: string): Promise<bigint> {
		const r = await this.api<{ credited: string }>("POST", "/api/deposit/claim", { txid }, 30_000);
		return BigInt(r.credited);
	}

	/** POST /api/withdraw — burn `amount` gBTC of the active account for a BTC payout of amount − fee. */
	async withdraw(amount: bigint, btcAddress: string, fee: bigint): Promise<void> {
		await this.api("POST", "/api/withdraw", { amount: amount.toString(), btcAddress, fee: fee.toString() });
	}

	/** POST /api/withdrawals/process — co-sign + broadcast pending withdrawals now (blocks on the ceremony). */
	async processWithdrawals(timeoutMs = 120_000): Promise<string | null> {
		const r = await this.api<{ txid: string | null }>("POST", "/api/withdrawals/process", {}, timeoutMs);
		return r.txid;
	}
}

export class Cluster {
	readonly runDir: string;
	readonly network: string;
	readonly relay: LocalRelay;
	readonly btc: RegtestNode;
	readonly shim: EsploraShim;
	readonly nodes: DaemonProc[];
	/** The src/ copy every daemon (incl. restarts) runs from — see `snapshotSource`. */
	readonly codeDir: string;
	/** What the snapshot was taken from: HEAD + uncommitted src/ changes at start. */
	readonly source: string;

	private constructor(p: { runDir: string; network: string; relay: LocalRelay; btc: RegtestNode; shim: EsploraShim; nodes: DaemonProc[]; codeDir: string; source: string }) {
		this.runDir = p.runDir;
		this.network = p.network;
		this.relay = p.relay;
		this.btc = p.btc;
		this.shim = p.shim;
		this.nodes = p.nodes;
		this.codeDir = p.codeDir;
		this.source = p.source;
	}

	/**
	 * Copy src/ once per run so every daemon — including one restarted twenty minutes in — runs the
	 * SAME code, even while the working tree is being edited. `ref` takes src/ from that git ref
	 * (`git archive`) instead of the working tree. The copy lives under ROOT (in the git-ignored
	 * .regtest-bin/) so bare imports still resolve from ROOT/node_modules.
	 */
	private static snapshotSource(runDir: string, ref?: string): { codeDir: string; source: string } {
		const codeDir = path.join(BIN_ROOT, "snapshots", path.basename(runDir));
		mkdirSync(codeDir, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
		if (ref) {
			const tar = execFileSync("git", ["-C", ROOT, "archive", "--format=tar", ref, "src"], { maxBuffer: 256 * 1024 * 1024 });
			execFileSync("tar", ["-x", "-C", codeDir], { input: tar });
			return { codeDir, source: `git ${ref} (${git("rev-parse", "--short", ref)})` };
		}
		cpSync(path.join(ROOT, "src"), path.join(codeDir, "src"), { recursive: true });
		const dirty = git("status", "--porcelain", "--", "src").split("\n").filter(Boolean);
		return { codeDir, source: `working tree at ${git("rev-parse", "--short", "HEAD")}${dirty.length ? ` + ${dirty.length} uncommitted src change(s): ${dirty.map((l) => l.slice(3)).join(", ")}` : " (clean src)"}` };
	}

	/** The env every daemon gets (before its per-node GAVL_DATA_DIR / GAVL_PORT). */
	static daemonEnv(o: ClusterOptions, network: string, relayUrl: string, esploraUrl: string): Record<string, string> {
		return {
			GAVL_NETWORK: network,
			GAVL_RELAYS: relayUrl,
			GAVL_BTC_NET: "regtest",
			GAVL_ESPLORA_URL: esploraUrl,
			GAVL_VDF: "hash",
			GAVL_SPACE: "standin",
			GAVL_PERSIST: o.persist ?? "all",
			GAVL_COMMITTEE_MAX: String(o.committeeMax ?? o.n),
			GAVL_CUSTODY_MIN: String(o.minCommittee ?? 3),
			GAVL_CUSTODY_EPOCH: String(o.epochLength ?? 24),
			GAVL_CUSTODY_TIMEOUT_MS: "15000",
			GAVL_RETARGET: "0", // constant difficulty: anchor cadence is set by the pace knobs below, not a retarget toward 60 s
			GAVL_HEARTBEAT_MS: "4000",
			GAVL_BOOTSTRAP_PACE_MS: "4000", // also the pace floor while peers exist (producer.runAdaptive hasPeers)
			GAVL_ANNOUNCE_INTERVAL: "5",
			GAVL_LIVE_PEER_MS: "30000",
			...o.env,
		};
	}

	static async start(o: ClusterOptions): Promise<Cluster> {
		const runDir = mkdtempSync(path.join(o.baseDir ?? tmpdir(), "gavl-cluster-"));
		const network = `gavl-churn-${Date.now().toString(36)}`;
		const { codeDir, source } = Cluster.snapshotSource(runDir, o.sourceRef);
		const relay = await startRelay();
		let btc: RegtestNode | undefined;
		let shim: EsploraShim | undefined;
		const nodes: DaemonProc[] = [];
		try {
			btc = await RegtestNode.start("bitcoin");
			shim = await startEsploraShim(btc);
			const env = Cluster.daemonEnv(o, network, relay.url, shim.url);
			const server = path.join(codeDir, "src", "server.ts");
			for (let i = 0; i < o.n; i++) nodes.push(new DaemonProc(i, await freePort(), runDir, env, server));
			await Promise.all(nodes.map((d) => d.start()));
			return new Cluster({ runDir, network, relay, btc, shim, nodes, codeDir, source });
		} catch (e) {
			await Promise.all(nodes.map((d) => d.kill()));
			await shim?.close();
			await btc?.stop();
			await relay.close();
			rmSync(codeDir, { recursive: true, force: true });
			throw e;
		}
	}

	liveNodes(): DaemonProc[] {
		return this.nodes.filter((d) => d.alive);
	}

	/** /api/state of every live node; a node that doesn't answer maps to null. */
	async states(): Promise<Map<DaemonProc, NodeState | null>> {
		const live = this.liveNodes();
		const got = await Promise.all(live.map((d) => d.state().catch(() => null)));
		return new Map(live.map((d, i) => [d, got[i]!]));
	}

	/** Tails of every node log, for failure reports. */
	tails(n = 40): string {
		return this.nodes.map((d) => `──── ${d.name} (${d.alive ? "alive" : "down"}) ${d.logPath} ────\n${d.tail(n)}`).join("\n");
	}

	/** SIGKILL every daemon, stop bitcoind/shim/relay, drop the source snapshot. Keeps the run dir
	 *  (logs) unless `removeRunDir`. */
	async stop(removeRunDir = false): Promise<void> {
		await Promise.all(this.nodes.map((d) => d.kill()));
		await this.shim.close();
		await this.btc.stop();
		await this.relay.close();
		rmSync(this.codeDir, { recursive: true, force: true });
		if (removeRunDir) rmSync(this.runDir, { recursive: true, force: true });
	}
}
