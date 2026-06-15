/**
 * Oracle price feed — where the publisher gets the actual number.
 *
 * The publisher (and ONLY the publisher) fetches a real price from an HTTP
 * endpoint, extracts a value by JSON key-path, and signs it into an `oracle.post`.
 * Other nodes never fetch — they fold the signed value. So this is the publisher's
 * private data source; the signature is what's canonical on-chain.
 *
 * A reading records everything for transparency: the endpoint, the key-path, the
 * RAW value pulled, and the parsed integer price — so the operator can see exactly
 * how the number was derived.
 */

export interface PriceSource {
	/** HTTP endpoint returning JSON (e.g. Coinbase spot). */
	url?: string;
	/** Dot-path to the number within the JSON (e.g. "data.amount"). */
	key?: string;
	/** Fixed dev price (used when no url is given). */
	fixed?: bigint;
}

export interface PriceReading {
	value: bigint | null; // parsed integer price (floored), or null on failure
	raw: string | null; // the raw value at the key-path, verbatim
	endpoint: string | null; // the URL fetched (null for a fixed price)
	key: string | null; // the key-path extracted
	error?: string;
}

/** Sensible default: Coinbase BTC-USD spot, no API key required. */
export const DEFAULT_SOURCE: PriceSource = { url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", key: "data.amount" };

/** Three independent BTC-USD feeds (no API keys). The publisher averages the ones
 *  that respond, so one source being down/wrong/manipulated can't set the price. */
export const DEFAULT_SOURCES: PriceSource[] = [
	{ url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", key: "data.amount" },
	{ url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", key: "result.XXBTZUSD.c.0" },
	{ url: "https://www.bitstamp.net/api/v2/ticker/btcusd/", key: "last" },
];

export interface AggregateReading {
	value: bigint | null; // average of the sources that responded (floored), or null if none did
	method: string; // human description, e.g. "average of 3/3 sources"
	used: number; // how many sources contributed
	readings: PriceReading[]; // per-source detail (value/raw/endpoint/key/error)
}

/**
 * Fetch every source concurrently and AVERAGE the ones that returned a number.
 * A failed/missing source is simply excluded — the price still posts as long as
 * at least one responds. Returns the average plus each source's reading, so the
 * full provenance (every endpoint, key, raw value) stays visible.
 */
export async function readPriceAggregate(sources: PriceSource[]): Promise<AggregateReading> {
	const readings = await Promise.all(sources.map((s) => readPrice(s)));
	const ok = readings.filter((r) => r.value != null);
	if (ok.length === 0) return { value: null, method: `average of 0/${sources.length} sources`, used: 0, readings };
	const sum = ok.reduce((a, r) => a + r.value!, 0n);
	return { value: sum / BigInt(ok.length), method: `average of ${ok.length}/${sources.length} sources`, used: ok.length, readings };
}

/** Read a dot-path (e.g. "data.amount") out of a parsed JSON object. */
function getPath(obj: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Parse a price string/number to a floored integer bigint, or null. */
function toInt(raw: unknown): bigint | null {
	if (raw == null) return null;
	const n = typeof raw === "number" ? raw : Number(String(raw));
	if (!Number.isFinite(n) || n <= 0) return null;
	return BigInt(Math.floor(n));
}

/**
 * Resolve a price from a source. Fixed → returns it directly. HTTP → fetches,
 * extracts the key-path, parses. Always returns a PriceReading (with `error` set
 * on failure) so the caller can surface the source state instead of throwing.
 */
/** Hermes endpoint serving the latest Wormhole-attested Pyth price updates. */
export const HERMES_URL = process.env.GAVL_HERMES_URL ?? "https://hermes.pyth.network";

/** Fetch the latest signed Pyth update blob (hex) for `feedId` from Hermes. The blob is
 *  guardian-attested, so it's verified on-chain — Hermes (or any relay) is untrusted transport. */
export async function fetchPythUpdate(feedId: string): Promise<string | null> {
	try {
		const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?ids[]=${feedId}&encoding=hex`, { headers: { accept: "application/json" } });
		if (!res.ok) return null;
		const json = (await res.json()) as { binary?: { data?: string[] } };
		return json.binary?.data?.[0] ?? null;
	} catch {
		return null;
	}
}

export async function readPrice(src: PriceSource): Promise<PriceReading> {
	if (src.fixed != null) {
		return { value: src.fixed, raw: src.fixed.toString(), endpoint: null, key: null };
	}
	const url = src.url ?? DEFAULT_SOURCE.url!;
	const key = src.key ?? DEFAULT_SOURCE.key!;
	try {
		const res = await fetch(url, { headers: { accept: "application/json" } });
		if (!res.ok) return { value: null, raw: null, endpoint: url, key, error: `HTTP ${res.status}` };
		const json = await res.json();
		const raw = getPath(json, key);
		const value = toInt(raw);
		if (value == null) return { value: null, raw: raw == null ? null : String(raw), endpoint: url, key, error: `no numeric value at "${key}"` };
		return { value, raw: String(raw), endpoint: url, key };
	} catch (e) {
		return { value: null, raw: null, endpoint: url, key, error: (e as Error).message };
	}
}
