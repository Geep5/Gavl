/**
 * Feed source helpers — the "where the number comes from" half of a signed feed, shared by the
 * signer / member / aggregator utilities. None of this is consensus: it reads an unsigned upstream
 * (your pricing infra, or a public API) and scales it; the SIGNING + quorum verification (the part
 * that's authoritative on-chain) lives in ./signed-feed.ts.
 *
 * It also holds the member-side AGREEMENT policy: a member co-signs a proposed reading only if it's
 * fresh and within tolerance of what the member independently fetched. That independent check is what
 * makes an M-of-N feed real — a member never blind-signs a coordinator's number, so a quorum forms
 * only when ≥ M members each verify the price against their OWN source.
 */

/** Walk a dot-path (`a.b.c`) into a parsed JSON object; undefined if any hop is missing. */
export function atPath(obj: unknown, dotted: string): unknown {
	return dotted.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Exactly scale a decimal string to an integer at 10^expo — no float rounding. "640.5", -2 → 64050. */
export function scaleDecimal(s: string, e: number): bigint {
	const decimals = -e; // fractional digits to keep
	const neg = s.trim().startsWith("-");
	const t = s.trim().replace(/^[-+]/, "");
	const dot = t.indexOf(".");
	const intPart = dot < 0 ? t : t.slice(0, dot);
	const fracRaw = dot < 0 ? "" : t.slice(dot + 1);
	const frac = (fracRaw + "0".repeat(Math.max(0, decimals))).slice(0, Math.max(0, decimals));
	const digits = ((intPart || "0") + frac).replace(/^0+(?=\d)/, "") || "0";
	const v = BigInt(digits);
	return neg ? -v : v;
}

/** Fetch `url`, extract the value at `dotted`, and scale it to an integer at 10^expo. Returns null on
 *  any failure (HTTP error, missing path, non-positive). The integer is the on-the-wire price. */
export async function readUpstreamPrice(url: string, dotted: string, expo: number): Promise<bigint | null> {
	try {
		const res = await fetch(url, { headers: { accept: "application/json" } });
		if (!res.ok) return null;
		const raw = atPath(await res.json(), dotted);
		if (raw == null) return null;
		const price = scaleDecimal(String(raw), expo);
		return price > 0n ? price : null;
	} catch {
		return null;
	}
}

/** Absolute deviation between two integer prices, in basis points of `reference` (1% = 100 bps).
 *  Used by a member to decide if a proposed price is close enough to its own to attest to. */
export function deviationBps(proposed: bigint, reference: bigint): bigint {
	if (reference <= 0n) return 1n << 62n; // no usable reference → effectively infinite deviation
	const diff = proposed > reference ? proposed - reference : reference - proposed;
	return (diff * 10_000n) / reference;
}

/** A proposed reading a member is asked to co-sign (price as a decimal string, BigInt-safe). */
export interface Proposal {
	price: string;
	expo: number;
	publishTime: number;
}

/** A member's decision on whether to co-sign a proposal. It signs ONLY if (a) the publish-time is
 *  within `maxSkewSec` of now (not stale, not far-future) and (b) the proposed price is within
 *  `toleranceBps` of the price the member just fetched ITSELF. This independent agreement — not the
 *  coordinator's say-so — is the authority; a bad proposal simply fails to gather a quorum. */
export function memberApproves(p: Proposal, ownPrice: bigint, opts: { toleranceBps: number; nowSec: number; maxSkewSec: number }): { ok: true } | { ok: false; reason: string } {
	let price: bigint;
	try {
		price = BigInt(p.price);
	} catch {
		return { ok: false, reason: "unparseable price" };
	}
	if (price <= 0n) return { ok: false, reason: "non-positive price" };
	if (!Number.isInteger(p.publishTime)) return { ok: false, reason: "bad publishTime" };
	const skew = Math.abs(p.publishTime - opts.nowSec);
	if (skew > opts.maxSkewSec) return { ok: false, reason: `publishTime off by ${skew}s (> ${opts.maxSkewSec}s)` };
	if (ownPrice <= 0n) return { ok: false, reason: "no own reading to compare against" };
	const dev = deviationBps(price, ownPrice);
	if (dev > BigInt(opts.toleranceBps)) return { ok: false, reason: `price off by ${dev}bps (> ${opts.toleranceBps}bps) vs my ${ownPrice}` };
	return { ok: true };
}
