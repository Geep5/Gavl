/**
 * Esplora REST client — a swap daemon's window onto the Bitcoin and Litecoin chains.
 *
 * Atomic swaps settle on-chain: the daemon watches HTLC addresses for funding, reads claim
 * witnesses (to learn the preimage), and broadcasts its own claim/refund transactions. All of
 * that goes through an Esplora-compatible REST API (mempool.space / blockstream.info for Bitcoin,
 * litecoinspace.org for Litecoin, or a local server on regtest).
 *
 * TESTNET by default — real protocol, zero financial risk; mainnet is never selected implicitly.
 * REGTEST has no public explorer: point `GAVL_BTC_ESPLORA_URL` / `GAVL_LTC_ESPLORA_URL` at a local
 * Esplora-compatible server.
 *
 * No deps (fetch). Network I/O, so it lives outside the deterministic fold.
 */

export type Chain = "bitcoin" | "litecoin";
export type Net = "mainnet" | "testnet" | "regtest";

const NET_ENV: Record<Chain, string> = { bitcoin: "GAVL_BTC_NET", litecoin: "GAVL_LTC_NET" };
const URL_ENV: Record<Chain, string> = { bitcoin: "GAVL_BTC_ESPLORA_URL", litecoin: "GAVL_LTC_ESPLORA_URL" };

/** A chain's network from `GAVL_BTC_NET` / `GAVL_LTC_NET` (mainnet | testnet | regtest); anything
 *  else (incl. unset) is testnet — mainnet is never selected implicitly. */
export function netFromEnv(chain: Chain, v: string | undefined = process.env[NET_ENV[chain]]): Net {
	return v === "mainnet" || v === "regtest" ? v : "testnet";
}

/** Explorer bases from `GAVL_BTC_ESPLORA_URL` / `GAVL_LTC_ESPLORA_URL` (comma-separated Esplora REST
 *  roots, e.g. `http://127.0.0.1:3002`), or undefined when unset → the network's DEFAULT_BASES. */
export function esploraBasesFromEnv(chain: Chain, v: string | undefined = process.env[URL_ENV[chain]]): string[] | undefined {
	const bases = (v ?? "")
		.split(",")
		.map((b) => b.trim().replace(/\/+$/, ""))
		.filter((b) => b.length > 0);
	return bases.length > 0 ? bases : undefined;
}

/** Esplora-compatible endpoints per chain + network, tried IN ORDER (failover). A swap daemon must
 *  not hang off a single provider: a claim or refund has to land before its timelock window closes,
 *  whichever explorer happens to be down. The client fails over on connection errors, timeouts, and
 *  5xx, and remembers the endpoint that worked so steady-state traffic doesn't re-pay a dead
 *  endpoint's timeout on every call. */
export const DEFAULT_BASES: Record<Chain, Record<Net, string[]>> = {
	bitcoin: {
		mainnet: ["https://mempool.space/api", "https://blockstream.info/api"],
		testnet: ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"],
		regtest: [], // local chain only — needs GAVL_BTC_ESPLORA_URL
	},
	litecoin: {
		mainnet: ["https://litecoinspace.org/api"],
		testnet: ["https://litecoinspace.org/testnet/api"],
		regtest: [], // local chain only — needs GAVL_LTC_ESPLORA_URL
	},
};

export interface EsploraStatus {
	confirmed: boolean;
	block_height?: number;
	block_hash?: string;
	block_time?: number;
}
export interface EsploraVout {
	scriptpubkey?: string; // hex
	scriptpubkey_address?: string;
	value: number; // base units (sats / litoshis)
}
export interface EsploraVin {
	txid?: string; // absent on coinbase
	vout?: number;
	witness?: string[]; // hex stack items; absent when empty
	sequence: number;
	prevout?: EsploraVout | null;
	is_coinbase?: boolean;
}
export interface EsploraTx {
	txid: string;
	vin?: EsploraVin[];
	vout: EsploraVout[];
	status: EsploraStatus;
}
export interface EsploraUtxo {
	txid: string;
	vout: number;
	value: number; // base units
	status: EsploraStatus;
}

export interface EsploraOptions {
	chain?: Chain; // default bitcoin
	net?: Net; // default testnet
	base?: string; // a single endpoint (overrides `bases`)
	bases?: string[]; // endpoints tried in order; default DEFAULT_BASES[chain][net]
	timeoutMs?: number; // per request, default 10s
}

export class Esplora {
	readonly chain: Chain;
	readonly net: Net;
	private readonly bases: string[];
	private preferred = 0; // index of the last endpoint that answered — start there next time
	private readonly timeoutMs: number;

	constructor(opts: EsploraOptions = {}) {
		this.chain = opts.chain ?? "bitcoin";
		this.net = opts.net ?? "testnet";
		this.bases = opts.base ? [opts.base] : opts.bases?.length ? opts.bases : DEFAULT_BASES[this.chain][this.net];
		this.timeoutMs = opts.timeoutMs ?? 10_000;
	}

	/** The client for `chain` as configured by the environment (`GAVL_{BTC,LTC}_NET`, `GAVL_{BTC,LTC}_ESPLORA_URL`). */
	static fromEnv(chain: Chain, timeoutMs?: number): Esplora {
		return new Esplora({ chain, net: netFromEnv(chain), bases: esploraBasesFromEnv(chain), timeoutMs });
	}

	/** One request with endpoint FAILOVER: try each base, starting from the last one that worked. A
	 *  connection error, timeout, or 5xx moves to the next; a 4xx (incl. 404) is a real answer from a
	 *  healthy endpoint and is returned, never failed over. Safe for broadcast too: rebroadcasting an
	 *  identical raw tx is idempotent (same txid), so retrying POST /tx elsewhere can't double-spend. */
	private async req(path: string, init?: RequestInit): Promise<Response> {
		if (this.bases.length === 0) throw new Error(`esplora: no endpoint for ${this.chain} ${this.net} — set ${URL_ENV[this.chain]}`);
		let lastErr: unknown = null;
		for (let i = 0; i < this.bases.length; i++) {
			const at = (this.preferred + i) % this.bases.length;
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
			try {
				const r = await fetch(this.bases[at] + path, { ...init, signal: ctrl.signal });
				if (r.status >= 500) {
					lastErr = new Error(`esplora ${this.bases[at]}: HTTP ${r.status}`);
					continue; // a sick endpoint — try the next
				}
				this.preferred = at; // healthy — start here next time
				return r;
			} catch (e) {
				lastErr = e; // network error / abort (timeout) — try the next
			} finally {
				clearTimeout(t);
			}
		}
		throw new Error(`esplora: all endpoints failed (${this.bases.join(", ")}) — last: ${String((lastErr as Error)?.message ?? lastErr)}`);
	}

	/** Current chain tip height (for computing confirmations and relative timelocks). */
	async tipHeight(): Promise<number> {
		const r = await this.req("/blocks/tip/height");
		if (!r.ok) throw new Error(`esplora tip: HTTP ${r.status}`);
		return Number((await r.text()).trim());
	}

	/** A transaction by id, or null if not found. */
	async getTx(txid: string): Promise<EsploraTx | null> {
		const r = await this.req(`/tx/${txid}`);
		if (r.status === 404) return null;
		if (!r.ok) throw new Error(`esplora tx: HTTP ${r.status}`);
		return (await r.json()) as EsploraTx;
	}

	/** Confirmed + mempool UTXOs paying `address`. */
	async utxos(address: string): Promise<EsploraUtxo[]> {
		const r = await this.req(`/address/${address}/utxo`);
		if (!r.ok) throw new Error(`esplora utxo: HTTP ${r.status}`);
		return (await r.json()) as EsploraUtxo[];
	}

	/** Recent transactions touching `address` (newest first). */
	async addressTxs(address: string): Promise<EsploraTx[]> {
		const r = await this.req(`/address/${address}/txs`);
		if (!r.ok) throw new Error(`esplora txs: HTTP ${r.status}`);
		return (await r.json()) as EsploraTx[];
	}

	/** Broadcast a raw signed transaction (hex). Returns the txid. */
	async broadcast(rawHex: string): Promise<string> {
		const r = await this.req("/tx", { method: "POST", body: rawHex, headers: { "content-type": "text/plain" } });
		const body = (await r.text()).trim();
		if (!r.ok) throw new Error(`esplora broadcast rejected: ${body || r.status}`);
		return body; // txid
	}
}
