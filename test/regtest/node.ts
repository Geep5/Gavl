/**
 * Local regtest nodes (Bitcoin Core / Litecoin Core) for tests that must prove the
 * real node software accepts the transactions Gavl builds.
 *
 * Binaries come from `npm run regtest:install` (scripts/regtest/install.mjs, into
 * .regtest-bin/). Each node runs in a fresh temp datadir on a free RPC port, with
 * P2P disabled, a `gavl` wallet, and 101 blocks pre-mined so the wallet has a mature
 * coinbase to spend. Same API for both chains; JSON-RPC 1.0 over HTTP, cookie auth.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { NETWORK } from "@scure/btc-signer";
import { binaries, RELEASES, type Chain } from "../../scripts/regtest/releases.ts";

export type { Chain } from "../../scripts/regtest/releases.ts";
export type BtcNetwork = typeof NETWORK;

/**
 * @scure/btc-signer network params per chain's regtest.
 *
 * Bitcoin Core regtest (src/kernel/chainparams.cpp, CRegTestParams): bech32 "bcrt",
 * PUBKEY_ADDRESS 111, SCRIPT_ADDRESS 196, SECRET_KEY 239.
 *
 * Litecoin Core regtest (litecoin-project/litecoin master == v0.21.5.8,
 * src/chainparams.cpp, CRegTestParams):
 *   L371 base58Prefixes[PUBKEY_ADDRESS]  = 111
 *   L372 base58Prefixes[SCRIPT_ADDRESS]  = 196  (legacy P2SH — still decoded, key_io.cpp L97)
 *   L373 base58Prefixes[SCRIPT_ADDRESS2] = 58   (P2SH prefix the node ENCODES with, key_io.cpp L37)
 *   L374 base58Prefixes[SECRET_KEY]      = 239
 *   L378 bech32_hrp = "rltc"
 * scriptHash is 58 so P2SH addresses we print match what litecoind prints.
 */
export const REGTEST_NETWORKS: Record<Chain, BtcNetwork> = {
	bitcoin: { bech32: "bcrt", pubKeyHash: 111, scriptHash: 196, wif: 239 },
	litecoin: { bech32: "rltc", pubKeyHash: 111, scriptHash: 58, wif: 239 },
};

export class RpcError extends Error {
	readonly method: string;
	readonly code: number;
	constructor(method: string, code: number, message: string) {
		super(`${method}: ${message} (code ${code})`);
		this.method = method;
		this.code = code;
	}
}

export interface FundedUtxo {
	txid: string;
	vout: number;
	/** sats */
	amount: bigint;
	/** hex scriptPubKey of the funded output */
	scriptPubKey: string;
}

export interface MempoolAcceptResult {
	txid: string;
	allowed: boolean;
	"reject-reason"?: string;
	vsize?: number;
	fees?: { base: number };
}

export interface TaprootStatus {
	active: boolean;
	/** "buried" | "bip9" | … as the node reports it */
	type: string;
	/** the node's raw deployment entry */
	info: Record<string, unknown>;
}

const WALLET = "gavl";
const live = new Set<RegtestNode>();
process.once("exit", () => {
	for (const n of live) n.kill();
});

/** Format sats as an exact decimal coin amount string (RPC accepts strings). */
export function satsToCoins(sats: bigint): string {
	const neg = sats < 0n;
	const abs = neg ? -sats : sats;
	return `${neg ? "-" : ""}${abs / 100_000_000n}.${(abs % 100_000_000n).toString().padStart(8, "0")}`;
}

/** Convert an RPC coin amount (JSON number) to sats. */
export function coinsToSats(coins: number): bigint {
	return BigInt(Math.round(coins * 1e8));
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

export class RegtestNode {
	readonly chain: Chain;
	readonly datadir: string;
	readonly rpcPort: number;
	readonly network: BtcNetwork;
	private readonly proc: ChildProcess;
	private readonly exited: Promise<void>;
	private hasExited = false;
	private nextId = 1;
	private stderr = "";

	private constructor(chain: Chain, datadir: string, rpcPort: number, proc: ChildProcess) {
		this.chain = chain;
		this.datadir = datadir;
		this.rpcPort = rpcPort;
		this.proc = proc;
		this.network = REGTEST_NETWORKS[chain];
		proc.stderr?.on("data", (d: Buffer) => {
			this.stderr = (this.stderr + d.toString()).slice(-4000);
		});
		// `once` rejects on a spawn 'error' — either way the daemon is not running.
		const gone = () => {
			this.hasExited = true;
		};
		this.exited = once(proc, "exit").then(gone, gone);
	}

	/** Start a regtest node of `chain`, wait until RPC is ready, create the wallet and mine 101 blocks. */
	static async start(chain: Chain, opts: { readyTimeoutMs?: number } = {}): Promise<RegtestNode> {
		const { daemon } = binaries(chain);
		if (!existsSync(daemon)) throw new Error(`${daemon} missing — run \`npm run regtest:install\``);
		const datadir = mkdtempSync(path.join(tmpdir(), `gavl-regtest-${chain}-`));
		const rpcPort = await freePort();
		const args = [
			"-regtest",
			`-datadir=${datadir}`,
			`-rpcport=${rpcPort}`,
			"-rpcbind=127.0.0.1",
			"-rpcallowip=127.0.0.1",
			"-server=1",
			"-listen=0",
			"-dnsseed=0",
			"-txindex=1",
			"-fallbackfee=0.0002",
			"-printtoconsole=0",
		];
		const proc = spawn(daemon, args, { stdio: ["ignore", "ignore", "pipe"] });
		const node = new RegtestNode(chain, datadir, rpcPort, proc);
		live.add(node);
		try {
			await node.waitReady(opts.readyTimeoutMs ?? 60_000);
			await node.rpc("createwallet", [WALLET]);
			await node.mine(101);
		} catch (e) {
			await node.stop();
			throw e;
		}
		return node;
	}

	/** Daemon release version this node runs (e.g. "32.1"). */
	get version(): string {
		return RELEASES[this.chain].version;
	}

	private cookie(): string | null {
		const f = path.join(this.datadir, "regtest", ".cookie");
		return existsSync(f) ? readFileSync(f, "utf8").trim() : null;
	}

	private debugLogTail(): string {
		const f = path.join(this.datadir, "regtest", "debug.log");
		return existsSync(f) ? readFileSync(f, "utf8").split("\n").slice(-25).join("\n") : "";
	}

	private async waitReady(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.hasExited) throw new Error(`${this.chain}d exited during startup\n${this.stderr}\n${this.debugLogTail()}`);
			if (this.cookie()) {
				try {
					await this.rpc("getblockchaininfo");
					return;
				} catch (e) {
					// -28 = RPC_IN_WARMUP; connection errors = HTTP server not bound yet.
					if (e instanceof RpcError && e.code !== -28) throw e;
				}
			}
			if (Date.now() > deadline) throw new Error(`${this.chain} regtest not ready after ${timeoutMs} ms\n${this.debugLogTail()}`);
			await sleep(100);
		}
	}

	/** JSON-RPC call; `wallet` routes to /wallet/<name>. Throws RpcError on node errors. */
	async rpc<T = any>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
		const cookie = this.cookie();
		if (!cookie) throw new Error(`${this.chain}: no RPC cookie yet`);
		const url = `http://127.0.0.1:${this.rpcPort}/${wallet ? `wallet/${encodeURIComponent(wallet)}` : ""}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(cookie).toString("base64")}` },
			body: JSON.stringify({ jsonrpc: "1.0", id: this.nextId++, method, params }),
		});
		const text = await res.text();
		let body: { result?: T; error?: { code: number; message: string } | null };
		try {
			body = JSON.parse(text);
		} catch {
			throw new RpcError(method, -res.status, `HTTP ${res.status}: ${text.slice(0, 200)}`);
		}
		if (body.error) throw new RpcError(method, body.error.code, body.error.message);
		return body.result as T;
	}

	/** Wallet RPC on the node's `gavl` wallet. */
	walletRpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
		return this.rpc<T>(method, params, WALLET);
	}

	/** A fresh wallet address (`bech32` P2WPKH by default; bitcoind also takes `bech32m`). */
	newAddress(type = "bech32"): Promise<string> {
		return this.walletRpc<string>("getnewaddress", ["", type]);
	}

	/** Mine `n` blocks to `address` (default: a fresh wallet address). Returns block hashes. */
	async mine(n: number, address?: string): Promise<string[]> {
		return this.rpc<string[]>("generatetoaddress", [n, address ?? (await this.newAddress())]);
	}

	/** Hex scriptPubKey of `address`, as the node decodes it (throws if invalid on this chain). */
	async scriptPubKey(address: string): Promise<string> {
		const info = await this.rpc<{ isvalid: boolean; scriptPubKey?: string; error?: string }>("validateaddress", [address]);
		if (!info.isvalid || !info.scriptPubKey) throw new Error(`${this.chain}: invalid address ${address}${info.error ? `: ${info.error}` : ""}`);
		return info.scriptPubKey;
	}

	/** Send `sats` from the node wallet to `address`, mine `confirmations` blocks, return the funded outpoint. */
	async fund(address: string, sats: bigint, confirmations = 1): Promise<FundedUtxo> {
		const spk = await this.scriptPubKey(address);
		const txid = await this.walletRpc<string>("sendtoaddress", [address, satsToCoins(sats)]);
		if (confirmations > 0) await this.mine(confirmations);
		const tx = await this.getTransaction(txid);
		const out = tx.vout.find((o: { scriptPubKey: { hex: string } }) => o.scriptPubKey.hex === spk);
		if (!out) throw new Error(`${this.chain}: ${txid} has no output to ${address}`);
		return { txid, vout: out.n, amount: coinsToSats(out.value), scriptPubKey: spk };
	}

	/** `testmempoolaccept` for one raw tx. */
	async testMempoolAccept(hex: string): Promise<MempoolAcceptResult> {
		const [r] = await this.rpc<MempoolAcceptResult[]>("testmempoolaccept", [[hex]]);
		return r;
	}

	/** `sendrawtransaction`; returns the txid. */
	sendRawTransaction(hex: string): Promise<string> {
		return this.rpc<string>("sendrawtransaction", [hex]);
	}

	/** Verbose `getrawtransaction` (txindex is on, so confirmed txs resolve too). */
	getTransaction(txid: string): Promise<any> {
		return this.rpc("getrawtransaction", [txid, true]);
	}

	/**
	 * Taproot status at the tip. Litecoin Core 0.21 (no `getdeploymentinfo`) reports it in
	 * `getblockchaininfo.softforks.taproot`. Bitcoin Core 32 no longer lists a taproot
	 * deployment at all (it is buried from genesis on regtest); there the tip's enforced
	 * `getdeploymentinfo.script_flags` must include TAPROOT.
	 */
	async taproot(): Promise<TaprootStatus> {
		let deployment: Record<string, any>;
		try {
			deployment = await this.rpc("getdeploymentinfo");
		} catch (e) {
			if (!(e instanceof RpcError && e.code === -32601)) throw e; // -32601 = method not found
			const info = (await this.rpc("getblockchaininfo")).softforks?.taproot;
			if (!info) throw new Error(`${this.chain}: getblockchaininfo reports no taproot softfork`);
			return { active: info.active === true, type: String(info.type), info };
		}
		const info = deployment.deployments?.taproot;
		if (info) return { active: info.active === true, type: String(info.type), info };
		if (!Array.isArray(deployment.script_flags)) throw new Error(`${this.chain}: getdeploymentinfo reports neither a taproot deployment nor script_flags`);
		return { active: deployment.script_flags.includes("TAPROOT"), type: "script_flags", info: { script_flags: deployment.script_flags } };
	}

	/** Stop the daemon (RPC `stop`, SIGKILL after 30 s) and delete its datadir. */
	async stop(): Promise<void> {
		if (!this.hasExited) {
			await this.rpc("stop").catch(() => this.proc.kill("SIGTERM"));
			const timer = setTimeout(() => this.proc.kill("SIGKILL"), 30_000);
			await this.exited;
			clearTimeout(timer);
		}
		live.delete(this);
		rmSync(this.datadir, { recursive: true, force: true });
	}

	/** Synchronous hard kill + cleanup (process-exit safety net). */
	kill(): void {
		if (!this.hasExited) this.proc.kill("SIGKILL");
		rmSync(this.datadir, { recursive: true, force: true });
	}
}
