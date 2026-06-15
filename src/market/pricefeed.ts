/**
 * Price feed — where the publisher gets the latest signed Pyth update.
 *
 * Every market is a Pyth market: the price is attested by the Wormhole guardian network and verified
 * on-chain (see market/pyth.ts), so ANYONE may relay it and no node is trusted as a reporter. The
 * publisher (any node) just fetches the latest signed update blob from Hermes and posts it; other
 * nodes fold + verify the bytes. Hermes — or any relay — is untrusted transport.
 *
 * The reading types below are LOCAL provenance only (what this node last relayed): never on-chain,
 * shown in the UI so the operator can see the feed it's relaying and how fresh it is.
 */

export interface PriceReading {
	value: bigint | null; // the relayed integer price, or null on failure
	raw: string | null; // the raw value, verbatim (e.g. "6586530960605e-8")
	endpoint: string | null; // the source fetched (Hermes)
	key: string | null; // the Pyth feed id
	error?: string;
}

export interface AggregateReading {
	value: bigint | null; // the relayed price (floored), or null if none yet
	method: string; // human description, e.g. "Pyth e62df6c8b4…"
	used: number; // how many feeds contributed (1 for a single Pyth feed)
	readings: PriceReading[]; // per-feed detail (value/raw/endpoint/key/error)
}

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
