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

const DEFAULT_BASE: Record<EsploraNet, string> = {
	mainnet: "https://mempool.space/api",
	testnet: "https://mempool.space/testnet/api",
	signet: "https://mempool.space/signet/api",
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
	private readonly base: string;
	private readonly timeoutMs: number;

	constructor(opts: { net?: EsploraNet; base?: string; timeoutMs?: number } = {}) {
		this.net = opts.net ?? "testnet";
		this.base = opts.base ?? DEFAULT_BASE[this.net];
		this.timeoutMs = opts.timeoutMs ?? 10_000;
	}

	private async req(path: string, init?: RequestInit): Promise<Response> {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
		try {
			return await fetch(this.base + path, { ...init, signal: ctrl.signal });
		} finally {
			clearTimeout(t);
		}
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
