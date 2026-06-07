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
