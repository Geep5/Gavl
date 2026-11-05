/**
 * Esplora-compatible HTTP shim over a regtest node's JSON-RPC (bitcoind or litecoind), so the real
 * chain client (src/chains/esplora.ts) can run against a local chain:
 *
 *   const shim = await startEsploraShim(node);   // GAVL_BTC_ESPLORA_URL / GAVL_LTC_ESPLORA_URL = shim.url
 *
 * Serves exactly the endpoints src/chains/esplora.ts calls:
 *
 *   GET  /blocks/tip/height     → text: tip height
 *   GET  /tx/:txid              → JSON Esplora tx (confirmed via the index, or mempool); 404 text if unknown
 *   GET  /address/:addr/utxo    → JSON [{txid, vout, value, status}] — confirmed + mempool, minus mempool-spent
 *   GET  /address/:addr/txs     → JSON Esplora txs touching addr, newest first: ≤50 mempool, then ≤25 confirmed
 *   POST /tx  (body: raw hex)   → text: txid; 400 text `sendrawtransaction RPC error: {...}` on rejection
 *
 * Address lookups come from an in-process INDEX (what electrs is to Esplora), not the node wallet:
 * Bitcoin Core 32 only has descriptor wallets while the Litecoin Core 0.21.5.8 release binaries are
 * built without them ("Descriptor wallets not supported"), so a wallet import would need two code
 * paths plus a rescan per new address; `scantxoutset` has neither mempool nor history. The index
 * walks every block once (`getblock <hash> 2`, identical on both chains), tracks outputs, spends and
 * per-script history keyed by scriptPubKey hex (addresses are resolved with `validateaddress`, so
 * address formatting never matters), and overlays the mempool (`getrawmempool true` +
 * `getrawtransaction`) on every request. A reorg (our tip no longer on the active chain) rebuilds
 * the index from genesis — cheap at regtest sizes.
 *
 * Status codes follow the client's failover contract: 4xx is a real answer; RPC/transport failures
 * are 503 so a multi-endpoint client moves on.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { RpcError } from "./node.ts";

/** The slice of RegtestNode the shim needs. */
export interface RpcNode {
	rpc<T = any>(method: string, params?: unknown[]): Promise<T>;
}

interface RpcScriptPubKey {
	asm: string;
	hex: string;
	type: string;
	address?: string; // Bitcoin Core ≥ 22
	addresses?: string[]; // Litecoin Core 0.21
}
interface RpcVout {
	value: number;
	n: number;
	scriptPubKey?: RpcScriptPubKey; // absent on Litecoin MWEB outputs
}
interface RpcVin {
	txid?: string;
	vout?: number;
	coinbase?: string;
	scriptSig?: { asm: string; hex: string };
	txinwitness?: string[];
	sequence: number;
}
interface RpcTx {
	txid: string;
	version: number;
	locktime: number;
	size: number;
	weight: number;
	vin: RpcVin[];
	vout: RpcVout[];
}
interface RpcBlock {
	hash: string;
	height: number;
	time: number;
	previousblockhash?: string;
	tx: RpcTx[];
}

/** A transaction output as Esplora reports it (prevout / vout). */
interface Out {
	scriptpubkey: string;
	scriptpubkey_asm: string;
	scriptpubkey_type: string;
	scriptpubkey_address?: string;
	value: number; // sats
}
interface BlockRef {
	height: number;
	hash: string;
	time: number;
}
type Status = { confirmed: true; block_height: number; block_hash: string; block_time: number } | { confirmed: false };

/** Core's scriptPubKey.type → Esplora's scriptpubkey_type. */
const SCRIPT_TYPES: Record<string, string> = {
	pubkey: "p2pk",
	pubkeyhash: "p2pkh",
	scripthash: "p2sh",
	witness_v0_keyhash: "v0_p2wpkh",
	witness_v0_scripthash: "v0_p2wsh",
	witness_v1_taproot: "v1_p2tr",
	nulldata: "op_return",
	multisig: "multisig",
	anchor: "p2a",
};

const MEMPOOL_TXS_LIMIT = 50; // electrs: "up to 50 mempool transactions plus the first 25 confirmed"
const CHAIN_TXS_LIMIT = 25;
const MAX_BODY = 4 * 1024 * 1024;
const TXID = /^[0-9a-fA-F]{64}$/;

const sats = (coins: number): number => Math.round(coins * 1e8);
const op = (txid: string, n: number): string => `${txid}:${n}`;

function toOut(v: RpcVout): Out | null {
	const s = v.scriptPubKey;
	if (!s) return null;
	const address = s.address ?? s.addresses?.[0];
	return {
		scriptpubkey: s.hex,
		scriptpubkey_asm: s.asm,
		scriptpubkey_type: SCRIPT_TYPES[s.type] ?? "unknown",
		...(address ? { scriptpubkey_address: address } : {}),
		value: sats(v.value),
	};
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

class ChainIndex {
	private readonly node: RpcNode;
	/** Active-chain block hash per height, genesis … tip. */
	private hashes: string[] = [];
	private confirmed = new Map<string, { tx: RpcTx; block: BlockRef }>();
	/** Every output ever confirmed (prevout lookups for fees / spend history). */
	private outs = new Map<string, Out>();
	/** scriptPubKey hex → confirmed, not-yet-confirmed-spent outpoints. */
	private unspent = new Map<string, Set<string>>();
	/** scriptPubKey hex → confirmed txids touching it, chain order. */
	private history = new Map<string, string[]>();
	/** txid → mempool tx + entry time. */
	private readonly mempool = new Map<string, { tx: RpcTx; time: number }>();
	private readonly scripts = new Map<string, string>(); // address → scriptPubKey hex
	private queue: Promise<unknown> = Promise.resolve();

	constructor(node: RpcNode) {
		this.node = node;
	}

	/** Run `fn` after every earlier request: sync + read is one atomic step against the index. */
	serial<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn, fn);
		this.queue = p.catch(() => {});
		return p;
	}

	get tipHeight(): number {
		return this.hashes.length - 1;
	}

	/** Bring the index to the node's current tip + mempool. */
	async sync(): Promise<void> {
		await this.syncMempool(); // before the chain: a tx mined in between is then seen as confirmed
		await this.syncChain();
	}

	private reset(): void {
		this.hashes = [];
		this.confirmed = new Map();
		this.outs = new Map();
		this.unspent = new Map();
		this.history = new Map();
	}

	private async syncChain(): Promise<void> {
		for (;;) {
			const best = await this.node.rpc<string>("getbestblockhash");
			if (best === this.hashes.at(-1)) return;
			const count = await this.node.rpc<number>("getblockcount");
			const ours = this.tipHeight;
			if (ours >= 0 && (ours > count || (await this.blockHash(ours)) !== this.hashes[ours])) this.reset(); // reorg
			let consistent = true;
			for (let h = this.hashes.length; h <= count; h++) {
				const hash = await this.blockHash(h);
				const block = hash === null ? null : await this.node.rpc<RpcBlock>("getblock", [hash, 2]);
				if (!block || (h > 0 && block.previousblockhash !== this.hashes[h - 1])) {
					this.reset(); // the chain moved under us mid-walk — start over
					consistent = false;
					break;
				}
				this.addBlock(block);
			}
			if (consistent && this.hashes.at(-1) === best) return;
		}
	}

	private async blockHash(height: number): Promise<string | null> {
		try {
			return await this.node.rpc<string>("getblockhash", [height]);
		} catch (e) {
			if (e instanceof RpcError && e.code === -8) return null; // height out of range (chain shrank)
			throw e;
		}
	}

	private touch(script: string, txid: string): void {
		let h = this.history.get(script);
		if (!h) this.history.set(script, (h = []));
		if (h.at(-1) !== txid) h.push(txid);
	}

	private addBlock(block: RpcBlock): void {
		const ref: BlockRef = { height: block.height, hash: block.hash, time: block.time };
		this.hashes.push(block.hash);
		for (const tx of block.tx) {
			this.confirmed.set(tx.txid, { tx, block: ref });
			for (const vin of tx.vin) {
				if (vin.txid === undefined || vin.vout === undefined) continue; // coinbase / MWEB
				const spent = op(vin.txid, vin.vout);
				const prev = this.outs.get(spent);
				if (!prev) continue;
				this.unspent.get(prev.scriptpubkey)?.delete(spent);
				this.touch(prev.scriptpubkey, tx.txid);
			}
			for (const v of tx.vout) {
				const out = toOut(v);
				if (!out) continue;
				const o = op(tx.txid, v.n);
				this.outs.set(o, out);
				let set = this.unspent.get(out.scriptpubkey);
				if (!set) this.unspent.set(out.scriptpubkey, (set = new Set()));
				set.add(o);
				this.touch(out.scriptpubkey, tx.txid);
			}
		}
	}

	private async syncMempool(): Promise<void> {
		const pool = await this.node.rpc<Record<string, { time: number }>>("getrawmempool", [true]);
		for (const txid of this.mempool.keys()) if (!(txid in pool)) this.mempool.delete(txid);
		for (const [txid, entry] of Object.entries(pool)) {
			if (this.mempool.has(txid)) continue;
			try {
				this.mempool.set(txid, { tx: await this.node.rpc<RpcTx>("getrawtransaction", [txid, true]), time: entry.time });
			} catch (e) {
				if (!(e instanceof RpcError && e.code === -5)) throw e; // -5: left the mempool meanwhile
			}
		}
	}

	/** Mempool txs not (yet) indexed as confirmed, newest first. */
	private pending(): RpcTx[] {
		return [...this.mempool.entries()]
			.filter(([txid]) => !this.confirmed.has(txid))
			.sort((a, b) => b[1].time - a[1].time)
			.map(([, m]) => m.tx);
	}

	private prevout(txid: string, n: number): Out | null {
		const hit = this.outs.get(op(txid, n));
		if (hit) return hit;
		const m = this.mempool.get(txid)?.tx.vout.find((v) => v.n === n);
		return m ? toOut(m) : null;
	}

	private esploraTx(tx: RpcTx, block: BlockRef | null) {
		let inSum = 0;
		let outSum = 0;
		let coinbase = false;
		const vin = tx.vin.map((i) => {
			const isCoinbase = i.coinbase !== undefined;
			coinbase ||= isCoinbase;
			const prevout = isCoinbase || i.txid === undefined || i.vout === undefined ? null : this.prevout(i.txid, i.vout);
			inSum += prevout?.value ?? 0;
			return {
				txid: isCoinbase ? "0".repeat(64) : i.txid,
				vout: isCoinbase ? 0xffffffff : i.vout,
				prevout,
				scriptsig: isCoinbase ? i.coinbase : (i.scriptSig?.hex ?? ""),
				scriptsig_asm: isCoinbase ? "" : (i.scriptSig?.asm ?? ""),
				...(i.txinwitness?.length ? { witness: i.txinwitness } : {}),
				is_coinbase: isCoinbase,
				sequence: i.sequence,
			};
		});
		const vout = tx.vout.flatMap((v) => {
			const out = toOut(v);
			if (!out) return [];
			outSum += out.value;
			return [out];
		});
		const status: Status = block ? { confirmed: true, block_height: block.height, block_hash: block.hash, block_time: block.time } : { confirmed: false };
		return { txid: tx.txid, version: tx.version, locktime: tx.locktime, vin, vout, size: tx.size, weight: tx.weight, fee: coinbase ? 0 : inSum - outSum, status };
	}

	/** GET /tx/:txid */
	tx(txid: string) {
		const c = this.confirmed.get(txid);
		if (c) return this.esploraTx(c.tx, c.block);
		const m = this.mempool.get(txid);
		return m ? this.esploraTx(m.tx, null) : null;
	}

	/** Address → scriptPubKey hex, as the node decodes it on its own chain. */
	async script(address: string): Promise<string> {
		const cached = this.scripts.get(address);
		if (cached) return cached;
		const info = await this.node.rpc<{ isvalid: boolean; scriptPubKey?: string }>("validateaddress", [address]);
		if (!info.isvalid || !info.scriptPubKey) throw new HttpError(400, "Invalid Bitcoin address");
		this.scripts.set(address, info.scriptPubKey);
		return info.scriptPubKey;
	}

	private touches(tx: RpcTx, script: string): boolean {
		return (
			tx.vout.some((v) => v.scriptPubKey?.hex === script) ||
			tx.vin.some((i) => i.txid !== undefined && i.vout !== undefined && this.prevout(i.txid, i.vout)?.scriptpubkey === script)
		);
	}

	/** GET /address/:addr/utxo */
	utxos(script: string) {
		const pending = this.pending();
		const spentInMempool = new Set(pending.flatMap((tx) => tx.vin.filter((i) => i.txid !== undefined && i.vout !== undefined).map((i) => op(i.txid!, i.vout!))));
		const out: { txid: string; vout: number; value: number; status: Status }[] = [];
		for (const tx of pending) {
			for (const v of tx.vout) {
				if (v.scriptPubKey?.hex === script && !spentInMempool.has(op(tx.txid, v.n))) out.push({ txid: tx.txid, vout: v.n, value: sats(v.value), status: { confirmed: false } });
			}
		}
		const confirmed = [...(this.unspent.get(script) ?? [])].filter((o) => !spentInMempool.has(o));
		const rows = confirmed.map((o) => {
			const [txid, n] = o.split(":") as [string, string];
			const block = this.confirmed.get(txid)!.block;
			return { txid, vout: Number(n), value: this.outs.get(o)!.value, status: { confirmed: true, block_height: block.height, block_hash: block.hash, block_time: block.time } as Status };
		});
		rows.sort((a, b) => (b.status.confirmed ? b.status.block_height : 0) - (a.status.confirmed ? a.status.block_height : 0));
		return [...out, ...rows];
	}

	/** GET /address/:addr/txs */
	addressTxs(script: string) {
		const mempool = this.pending()
			.filter((tx) => this.touches(tx, script))
			.slice(0, MEMPOOL_TXS_LIMIT)
			.map((tx) => this.esploraTx(tx, null));
		const chain = (this.history.get(script) ?? [])
			.slice(-CHAIN_TXS_LIMIT)
			.reverse()
			.map((txid) => {
				const c = this.confirmed.get(txid)!;
				return this.esploraTx(c.tx, c.block);
			});
		return [...mempool, ...chain];
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const c of req as AsyncIterable<Buffer>) {
		size += c.length;
		if (size > MAX_BODY) throw new HttpError(413, "Payload too large");
		chunks.push(c);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
	const text = typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", "access-control-allow-origin": "*" });
	res.end(text);
}

/** `RpcError` carries "method: message (code N)"; Esplora relays the node's raw {code, message}. */
function rpcRejection(e: RpcError): string {
	const message = e.message.slice(`${e.method}: `.length).replace(/ \(code -?\d+\)$/, "");
	return `sendrawtransaction RPC error: ${JSON.stringify({ code: e.code, message })}`;
}

async function route(index: ChainIndex, node: RpcNode, req: IncomingMessage): Promise<[number, unknown]> {
	const path = new URL(req.url ?? "/", "http://shim").pathname;
	const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

	if (req.method === "POST" && path === "/tx") {
		const hex = (await readBody(req)).trim();
		try {
			return [200, await node.rpc<string>("sendrawtransaction", [hex])];
		} catch (e) {
			if (e instanceof RpcError) return [400, rpcRejection(e)];
			throw e;
		}
	}
	if (req.method !== "GET") return [404, "Not found"];

	return index.serial(async (): Promise<[number, unknown]> => {
		await index.sync();
		if (path === "/blocks/tip/height") return [200, String(index.tipHeight)];
		if (parts.length === 2 && parts[0] === "tx") {
			if (!TXID.test(parts[1]!)) return [400, "Invalid hex string"];
			const tx = index.tx(parts[1]!.toLowerCase());
			return tx ? [200, tx] : [404, "Transaction not found"];
		}
		if (parts.length === 3 && parts[0] === "address" && (parts[2] === "utxo" || parts[2] === "txs")) {
			const script = await index.script(parts[1]!);
			return [200, parts[2] === "utxo" ? index.utxos(script) : index.addressTxs(script)];
		}
		return [404, "Not found"];
	});
}

/** A running shim: `url` is the Esplora REST root (no trailing slash). */
export interface EsploraShim {
	url: string;
	close(): Promise<void>;
}

/** Start the shim on 127.0.0.1 (random port), after indexing the node's current chain. */
export async function startEsploraShim(node: RpcNode): Promise<EsploraShim> {
	const index = new ChainIndex(node);
	await index.serial(() => index.sync()); // index the existing chain up front; also proves RPC works

	const server = createServer((req, res) => {
		route(index, node, req).then(
			([status, body]) => send(res, status, body),
			(e: unknown) => {
				// HttpError = a real answer; anything else (node down, RPC failure) is the shim being sick.
				if (e instanceof HttpError) send(res, e.status, e.message);
				else send(res, 503, `esplora shim: ${(e as Error)?.message ?? String(e)}`);
			},
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const addr = server.address();
	if (!addr || typeof addr !== "object") throw new Error("esplora shim: no listen address");
	return {
		url: `http://127.0.0.1:${addr.port}`,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, "close");
		},
	};
}
