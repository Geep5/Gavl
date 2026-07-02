/**
 * Esplora REST client (Phase 4 #1) — the bridge's window onto the Bitcoin chain.
 *
 * The watcher uses this to (a) detect/verify deposits to the fund's Taproot
 * address and (b) fetch the fund's UTXOs and broadcast withdrawal txs. Read-only
 * calls are how the attestor confirms a deposit really landed on-chain; broadcast
 * pushes a quorum-signed withdrawal out.
 *
 * Defaults to mempool.space's Esplora-compatible API. TESTNET by default — real
 * Bitcoin protocol, zero financial risk. Mainnet is gated on an audit (see the
 * custody docs), so it must be selected explicitly.
 *
 * No deps (fetch). Network I/O, so it lives outside the deterministic fold; the
 * verification LOGIC it feeds (watcher.ts) is pure and tested.
 */

export type EsploraNet = "mainnet" | "testnet" | "signet";

/** Esplora-compatible endpoints per network, tried IN ORDER (failover). A custody bridge must not
 *  hang off a single provider: deposits can't verify and the committee can't co-sign while the one
 *  explorer is down (exactly what happened when mempool.space's testnet API went dark). The client
 *  fails over on connection errors, timeouts, and 5xx, and remembers the endpoint that worked so
 *  steady-state traffic doesn't re-pay a dead endpoint's timeout on every call. */
const DEFAULT_BASES: Record<EsploraNet, string[]> = {
	mainnet: ["https://mempool.space/api", "https://blockstream.info/api"],
	testnet: ["https://mempool.space/testnet/api", "https://blockstream.info/testnet/api"],
	signet: ["https://mempool.space/signet/api", "https://blockstream.info/signet/api"],
};

export interface EsploraStatus {
	confirmed: boolean;
	block_height?: number;
}
export interface EsploraVout {
	scriptpubkey_address?: string;
	value: number; // sats
}
export interface EsploraTx {
	txid: string;
	vout: EsploraVout[];
	status: EsploraStatus;
}
export interface EsploraUtxo {
	txid: string;
	vout: number;
	value: number; // sats
	status: EsploraStatus;
}

export class Esplora {
	readonly net: EsploraNet;
	private readonly bases: string[];
	private preferred = 0; // index of the last endpoint that answered — start there next time
	private readonly timeoutMs: number;

	constructor(opts: { net?: EsploraNet; base?: string; bases?: string[]; timeoutMs?: number } = {}) {
		this.net = opts.net ?? "testnet";
		this.bases = opts.base ? [opts.base] : opts.bases ?? DEFAULT_BASES[this.net];
		this.timeoutMs = opts.timeoutMs ?? 10_000;
	}

	/** One request with endpoint FAILOVER: try each base, starting from the last one that worked. A
	 *  connection error, timeout, or 5xx moves to the next; a 4xx (incl. 404) is a real answer from a
	 *  healthy endpoint and is returned, never failed over. Safe for broadcast too: rebroadcasting an
	 *  identical raw tx is idempotent on Bitcoin (same txid), so retrying POST /tx elsewhere can't
	 *  double-spend. */
	private async req(path: string, init?: RequestInit): Promise<Response> {
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

	/** Current chain tip height (for computing confirmations). */
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
