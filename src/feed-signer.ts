/**
 * Gavl feed signer — run a SIGNED price source, the open analog of a Pyth publisher.
 *
 * A Gavl market is named by its price SOURCE. `label::pyth::feedId` trusts Pyth's guardian set;
 * `label::signed::<sourcePubkey>` trusts ONE Ed25519 key — this signer's. It behaves just like
 * Pyth's Hermes, only at your own domain: it signs each reading and serves it, ANYONE relays it
 * on-chain, and the fold verifies the signature against the channel's committed key. So a reading
 * is provably from THIS source no matter who posts it — the trust is in whoever holds this KEY
 * (exactly as Pyth's users trust the guardians). One key is a single trust point; Pyth's 13/19
 * quorum is the multi-party version of the same idea.
 *
 * IMPORTANT: `--upstream` is only where this source READS its number — your own pricing infra, or
 * a public API for testing/bootstrapping. It does NOT make that upstream trustworthy: wrapping an
 * unsigned API (e.g. Coinbase) means the market trusts YOU to relay it faithfully, not the API.
 * The signer's KEY is the authority. For a real market, be a source people choose to trust.
 *
 * Run it:
 *   node src/feed-signer.ts \
 *     --upstream "https://api.coinbase.com/v2/prices/BTC-USD/spot" \
 *     --path data.amount --expo -2 --label BTC-USD
 *
 *   # generic JSON endpoint → dot-path to the price, expo = -(decimal places to keep)
 *   --upstream <url>   the HTTP endpoint THIS source reads (GET, JSON)
 *   --path <a.b.c>     dot-path to the price within the JSON (e.g. data.amount)
 *   --expo <n>         decimal exponent; real price = integer · 10^expo (e.g. -2 keeps cents)
 *   --label <name>     market label for the printed channel name (default: "feed")
 *   --key <file>       keyfile to load/create (default: ~/.gavl/feed-key.json) — the SOURCE key
 *   --port <n>         HTTP port to serve the signed update on (default: 8787)
 *   --every <ms>       refresh interval (default: 3000)
 *
 * It prints the channel name to share (`label::signed::<pubkey>`) and the URL relayers point a
 * node at (`GAVL_FEED_URL`). Guard the keyfile: whoever holds it IS the source for this market.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateKeyPair, keyPairFromSeed } from "./det/ed25519.ts";
import { toHex, fromHex } from "./det/canonical.ts";
import { signReading, type SignedUpdate } from "./market/signed-feed.ts";

// ── flags ────────────────────────────────────────────────────────────────
function flag(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const upstream = flag("upstream");
const pricePath = flag("path");
const expo = Number(flag("expo", "-8"));
const label = flag("label", "feed")!;
const keyFile = (flag("key", path.join(os.homedir(), ".gavl", "feed-key.json")) as string).replace(/^~(?=$|\/)/, os.homedir());
const port = Number(flag("port", "8787"));
const everyMs = Number(flag("every", "3000"));

if (!upstream || !pricePath || !Number.isInteger(expo)) {
	console.error("usage: node src/feed-signer.ts --upstream <url> --path <a.b.c> --expo <n> [--label NAME] [--key FILE] [--port N] [--every MS]");
	process.exit(1);
}

// ── the SOURCE key (the market's trust anchor) ─────────────────────────────
/** Load the signer's Ed25519 key from `keyFile`, or generate + persist a new one (0600). The
 *  stored secret is just the 32-byte seed; the public key is derived. This key IS the market. */
function loadOrCreateKey(file: string): { publicKey: Uint8Array; privateKey: Uint8Array } {
	try {
		const seed = fromHex((JSON.parse(fs.readFileSync(file, "utf8")) as { seed: string }).seed);
		const kp = keyPairFromSeed(seed);
		console.log(`  loaded source key from ${file}`);
		return kp;
	} catch {
		const kp = generateKeyPair();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ seed: toHex(kp.privateKey) }), { mode: 0o600 });
		console.log(`  generated a new source key → ${file} (keep it secret)`);
		return kp;
	}
}

const key = loadOrCreateKey(keyFile);
const sourcePub = toHex(key.publicKey);
const channel = `${label}::signed::${sourcePub}`;

// ── read the upstream value ────────────────────────────────────────────────
/** Walk a dot-path (`a.b.c`) into a parsed JSON object; undefined if any hop is missing. */
function atPath(obj: unknown, dotted: string): unknown {
	return dotted.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Exactly scale a decimal string to an integer at 10^expo — no float rounding. "640.5", -2 → 64050. */
function scaleDecimal(s: string, e: number): bigint {
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

/** Fetch the upstream, extract the price at `pricePath`, and produce a fresh signed reading. */
async function readAndSign(): Promise<SignedUpdate | null> {
	try {
		const res = await fetch(upstream!, { headers: { accept: "application/json" } });
		if (!res.ok) {
			console.error(`  upstream ${res.status}`);
			return null;
		}
		const raw = atPath(await res.json(), pricePath!);
		if (raw == null) {
			console.error(`  no value at path "${pricePath}"`);
			return null;
		}
		const price = scaleDecimal(String(raw), expo);
		if (price <= 0n) {
			console.error(`  non-positive price (${raw}) — skipping`);
			return null;
		}
		const publishTime = Math.floor(Date.now() / 1000);
		return signReading(price, expo, publishTime, key.privateKey);
	} catch (e) {
		console.error(`  fetch failed: ${(e as Error).message}`);
		return null;
	}
}

// ── serve + refresh ────────────────────────────────────────────────────────
let latest: SignedUpdate | null = null;

const server = http.createServer((req, resp) => {
	// the signed update — relayers GET this and post it; any node can verify it independently
	resp.setHeader("content-type", "application/json");
	resp.setHeader("access-control-allow-origin", "*"); // a price feed is public
	if (!latest) {
		resp.statusCode = 503;
		resp.end(JSON.stringify({ error: "no reading yet" }));
		return;
	}
	resp.end(JSON.stringify(latest));
});

async function tick(): Promise<void> {
	const u = await readAndSign();
	if (u) {
		latest = u;
		const real = Number(u.price) * 10 ** u.expo;
		console.log(`  signed ${label} = ${real.toLocaleString(undefined, { maximumFractionDigits: 6 })}  (t=${u.publishTime})`);
	}
}

server.listen(port, () => {
	console.log(`\nGavl feed signer — wrapping ${upstream}`);
	console.log(`  channel name (share this):  ${channel}`);
	console.log(`  relayers run a node with:   GAVL_FEED_URL=http://localhost:${port}/`);
	console.log(`  serving signed updates on:  http://localhost:${port}/\n`);
	void tick();
	setInterval(() => void tick(), everyMs);
});
