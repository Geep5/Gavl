/**
 * Gavl feed aggregator — the UNTRUSTED coordinator of a decentralized M-of-N price set.
 *
 * It does NOT hold any signing key and is NOT trusted: it proposes a reading, asks each member to
 * co-sign (each member independently re-fetches its own price and refuses if it disagrees — see
 * feed-member.ts), collects ≥ M signatures, assembles the quorum update, and serves it at the same
 * endpoint relayers already use (GAVL_FEED_URL). If the aggregator proposes a bad price, members
 * refuse → no quorum → the feed simply stalls; it can never forge. This is the Pyth model run on
 * your own infra: members are the guardians, the aggregator is Hermes (transport), the chain verifies.
 *
 * On start it GETs each member URL to learn its public key, builds the set, computes the channel
 * name (`label::signed::<setHash>`), and self-verifies every assembled update before serving it.
 *
 * Run it (after starting the members):
 *   node src/feed-aggregator.ts \
 *     --upstream "https://api.coinbase.com/v2/prices/BTC-USD/spot" --path data.amount --expo -2 \
 *     --label BTC-USD --members http://localhost:8788,http://localhost:8789,http://localhost:8790 \
 *     --threshold 2 --port 8787
 *
 *   --upstream <url>      where the aggregator SEEDS its proposal (members re-validate it themselves)
 *   --path <a.b.c>        dot-path to the price within the JSON
 *   --expo <n>            decimal exponent shared by the set (real price = integer · 10^expo)
 *   --label <name>        market label for the printed channel name (default "feed")
 *   --members <u1,u2,…>   member base URLs (each runs feed-member.ts)
 *   --threshold <M>       min member sigs an update needs (default ⌊2N/3⌋+1, Pyth-style)
 *   --port <n>            HTTP port to serve the assembled update on (default 8787)
 *   --every <ms>          round interval (default 3000)
 *
 * Relayers point a Gavl node at `GAVL_FEED_URL=http://localhost:<port>/` exactly as for any signed feed.
 */

import http from "node:http";

import { signerSetHash, buildSignedUpdate, verifySignedQuorum, type SignerSet, type SignedUpdate } from "./market/signed-feed.ts";
import { readUpstreamPrice, type Proposal } from "./market/feed-source.ts";

// ── flags ────────────────────────────────────────────────────────────────
function flag(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const upstream = flag("upstream");
const pricePath = flag("path");
const expo = Number(flag("expo", "-8"));
const label = flag("label", "feed")!;
const memberUrls = (flag("members", "") as string).split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);
const port = Number(flag("port", "8787"));
const everyMs = Number(flag("every", "3000"));

if (!upstream || !pricePath || !Number.isInteger(expo) || memberUrls.length === 0) {
	console.error("usage: node src/feed-aggregator.ts --upstream <url> --path <a.b.c> --expo <n> --members <u1,u2,…> [--label NAME] [--threshold M] [--port N] [--every MS]");
	process.exit(1);
}

// ── member RPC ─────────────────────────────────────────────────────────────
async function memberPubkey(url: string): Promise<string | null> {
	try {
		const res = await fetch(`${url}/`, { headers: { accept: "application/json" } });
		if (!res.ok) return null;
		const j = (await res.json()) as { pubkey?: string };
		return typeof j.pubkey === "string" && /^[0-9a-f]{64}$/i.test(j.pubkey) ? j.pubkey.toLowerCase() : null;
	} catch {
		return null;
	}
}

/** Ask one member to co-sign a proposal. Returns its signature, or null if it refused / was down. */
async function requestSig(url: string, p: Proposal): Promise<string | null> {
	try {
		const res = await fetch(`${url}/sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
		if (!res.ok) return null; // 409 = member disagreed (off-tolerance/stale) → just not counted
		const j = (await res.json()) as { sig?: string };
		return typeof j.sig === "string" ? j.sig : null;
	} catch {
		return null;
	}
}

// ── learn the set, then run rounds ──────────────────────────────────────────
let set: SignerSet;
let setHash: string;
let urlOf: Map<string, string>; // member pubkey → its URL
let latest: SignedUpdate | null = null;

async function discoverSet(threshold: number): Promise<void> {
	const found: { url: string; pub: string }[] = [];
	for (const url of memberUrls) {
		const pub = await memberPubkey(url);
		if (pub) found.push({ url, pub });
		else console.error(`  member ${url}: unreachable or no pubkey (will keep retrying each round)`);
	}
	if (found.length === 0) {
		console.error("  no members reachable — cannot form a set. Start the members first.");
		process.exit(1);
	}
	if (found.length < threshold) {
		console.error(`  only ${found.length} member(s) reachable but threshold is ${threshold} — cannot reach quorum.`);
		process.exit(1);
	}
	set = { threshold, signers: found.map((f) => f.pub) };
	setHash = signerSetHash(set);
	urlOf = new Map(found.map((f) => [f.pub.toLowerCase(), f.url]));
}

/** One round: seed a proposal from the upstream, collect member co-signatures in parallel, and
 *  assemble a quorum update if ≥ M agreed. The aggregator's own fetch only SEEDS the number —
 *  members re-validate it, so the assembled update is authoritative only because they signed it. */
async function round(): Promise<void> {
	const price = await readUpstreamPrice(upstream!, pricePath!, expo);
	if (price == null) {
		console.error(`  no usable price from ${upstream} — skipping round`);
		return;
	}
	const proposal: Proposal = { price: price.toString(), expo, publishTime: Math.floor(Date.now() / 1000) };

	const sigBySigner: Record<string, string> = {};
	await Promise.all(
		set.signers.map(async (pub) => {
			const url = urlOf.get(pub);
			if (!url) return;
			const sig = await requestSig(url, proposal);
			if (sig) sigBySigner[pub] = sig;
		}),
	);

	const got = Object.keys(sigBySigner).length;
	if (got < set.threshold) {
		console.log(`  round ${proposal.price}e${expo}: ${got}/${set.threshold} agreed — short of quorum, holding last good update`);
		return;
	}
	const update = buildSignedUpdate(price, expo, proposal.publishTime, set, sigBySigner);
	// self-verify against the committed set before publishing (defense in depth)
	if (!verifySignedQuorum(update, setHash)) {
		console.error("  assembled update failed self-verification — not publishing");
		return;
	}
	latest = update;
	const real = Number(price) * 10 ** expo;
	console.log(`  published ${real.toLocaleString(undefined, { maximumFractionDigits: 6 })} with ${got}/${set.signers.length} sigs (≥ ${set.threshold}) at t=${proposal.publishTime}`);
}

const server = http.createServer((req, resp) => {
	// the assembled quorum update — relayers GET this and post it on-chain; any node verifies it
	resp.setHeader("content-type", "application/json");
	resp.setHeader("access-control-allow-origin", "*");
	if (!latest) {
		resp.statusCode = 503;
		resp.end(JSON.stringify({ error: "no quorum update yet" }));
		return;
	}
	resp.end(JSON.stringify(latest));
});

(async () => {
	const N = memberUrls.length;
	const threshold = Number(flag("threshold", String(Math.floor((2 * N) / 3) + 1)));
	if (!Number.isInteger(threshold) || threshold < 1 || threshold > N) {
		console.error(`  --threshold must be an integer in 1..${N}`);
		process.exit(1);
	}
	await discoverSet(threshold);
	server.listen(port, () => {
		console.log(`\nGavl feed aggregator — ${set.threshold}-of-${set.signers.length} over ${upstream}`);
		console.log(`  channel name (share this):  ${label}::signed::${setHash}`);
		console.log(`  relayers run a node with:   GAVL_FEED_URL=http://localhost:${port}/`);
		console.log(`  serving assembled updates:  http://localhost:${port}/\n`);
		void round();
		setInterval(() => void round(), everyMs);
	});
})();
