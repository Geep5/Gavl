/**
 * Gavl feed signer — run a SIGNED price source, the open analog of a Pyth publisher.
 *
 * A Gavl market is named by its price source. `label::pyth::feedId` trusts Pyth's 13-of-19 guardian
 * set; `label::signed::<setHash>` trusts an M-of-N Ed25519 set YOU stand up. This utility runs a
 * source like Pyth's Hermes, only at your own domain: it signs each reading and serves a quorum
 * update, ANYONE relays it on-chain, and the fold verifies the quorum against the channel's committed
 * set. So a reading is provably from THIS set no matter who posts it, and — exactly like Pyth — no
 * single member can forge it.
 *
 * QUORUM. Point `--keys` at the member keyfiles this process holds and `--threshold` at M. It signs
 * each reading with every held member key and serves a complete update (the committed set + ≥ M
 * signatures). One key is the degenerate 1-of-1 set. This single-process multi-key signer is for a
 * solo operator or a demo — it exercises the same wire format + fold path end to end, but ONE machine
 * holds every key. For a genuinely decentralized M-of-N (members on independent machines, each
 * validating the price against its OWN source), run `feed-member.ts` per member + one `feed-aggregator.ts`.
 *
 * IMPORTANT: `--upstream` is only where this source READS its number — your own pricing infra, or
 * a public API for testing/bootstrapping. It does NOT make that upstream trustworthy: wrapping an
 * unsigned API (e.g. Coinbase) means the market trusts the SET to relay it faithfully, not the API.
 * The set's KEYS are the authority. For a real market, be a set people choose to trust.
 *
 * Run it:
 *   node src/feed-signer.ts \
 *     --upstream "https://api.coinbase.com/v2/prices/BTC-USD/spot" \
 *     --path data.amount --expo -2 --label BTC-USD --keys a.json,b.json,c.json --threshold 2
 *
 *   # generic JSON endpoint → dot-path to the price, expo = -(decimal places to keep)
 *   --upstream <url>   the HTTP endpoint THIS source reads (GET, JSON)
 *   --path <a.b.c>     dot-path to the price within the JSON (e.g. data.amount)
 *   --expo <n>         decimal exponent; real price = integer · 10^expo (e.g. -2 keeps cents)
 *   --label <name>     market label for the printed channel name (default: "feed")
 *   --keys <f1,f2,…>   member keyfiles to load/create (default: ~/.gavl/feed-key.json) — the SET
 *   --threshold <M>    min member sigs an update needs (default: ⌊2N/3⌋+1, Pyth-style)
 *   --port <n>         HTTP port to serve the signed update on (default: 8787)
 *   --every <ms>       refresh interval (default: 3000)
 *
 * It prints the channel name to share (`label::signed::<setHash>`) and the URL relayers point a
 * node at (`GAVL_FEED_URL`). Guard the keyfiles: whoever holds a quorum of them IS the source.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateKeyPair, keyPairFromSeed } from "./det/ed25519.ts";
import { toHex, fromHex } from "./det/canonical.ts";
import { signReading, signerSetHash, buildSignedUpdate, type SignerSet, type SignedUpdate } from "./market/signed-feed.ts";
import { readUpstreamPrice } from "./market/feed-source.ts";

// ── flags ────────────────────────────────────────────────────────────────
function flag(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const upstream = flag("upstream");
const pricePath = flag("path");
const expo = Number(flag("expo", "-8"));
const label = flag("label", "feed")!;
// --keys takes precedence; --key stays as a single-file alias for the 1-of-1 case.
const keyFiles = (flag("keys", flag("key", path.join(os.homedir(), ".gavl", "feed-key.json"))) as string).split(",").map((f) => f.trim().replace(/^~(?=$|\/)/, os.homedir()));
const port = Number(flag("port", "8787"));
const everyMs = Number(flag("every", "3000"));

if (!upstream || !pricePath || !Number.isInteger(expo)) {
	console.error("usage: node src/feed-signer.ts --upstream <url> --path <a.b.c> --expo <n> [--label NAME] [--keys F1,F2,…] [--threshold M] [--port N] [--every MS]");
	process.exit(1);
}

// ── the SOURCE set (the market's trust anchor) ─────────────────────────────
/** Load a member's Ed25519 key from `file`, or generate + persist a new one (0600). The stored
 *  secret is just the 32-byte seed; the public key is derived. The SET of these keys IS the market. */
function loadOrCreateKey(file: string): { publicKey: Uint8Array; privateKey: Uint8Array } {
	try {
		const seed = fromHex((JSON.parse(fs.readFileSync(file, "utf8")) as { seed: string }).seed);
		const kp = keyPairFromSeed(seed);
		console.log(`  loaded member key from ${file}`);
		return kp;
	} catch {
		const kp = generateKeyPair();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ seed: toHex(kp.privateKey) }), { mode: 0o600 });
		console.log(`  generated a new member key → ${file} (keep it secret)`);
		return kp;
	}
}

const members = keyFiles.map(loadOrCreateKey);
const N = members.length;
const threshold = Number(flag("threshold", String(Math.floor((2 * N) / 3) + 1)));
if (!Number.isInteger(threshold) || threshold < 1 || threshold > N) {
	console.error(`  --threshold must be an integer in 1..${N} (have ${N} key${N === 1 ? "" : "s"})`);
	process.exit(1);
}
const set: SignerSet = { threshold, signers: members.map((m) => toHex(m.publicKey)) };
const setHash = signerSetHash(set);
const channel = `${label}::signed::${setHash}`;

// ── read the upstream value ────────────────────────────────────────────────
/** Fetch the upstream, extract the price at `pricePath`, and produce a fresh quorum update — every
 *  held member signs the SAME reading, assembled into the committed set's wire form. */
async function readAndSign(): Promise<SignedUpdate | null> {
	const price = await readUpstreamPrice(upstream!, pricePath!, expo);
	if (price == null) {
		console.error(`  no usable price from ${upstream} at "${pricePath}"`);
		return null;
	}
	const publishTime = Math.floor(Date.now() / 1000);
	const sigBySigner: Record<string, string> = {};
	for (const m of members) sigBySigner[toHex(m.publicKey)] = signReading(price, expo, publishTime, m.privateKey);
	return buildSignedUpdate(price, expo, publishTime, set, sigBySigner);
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
	console.log(`  signer set:                 ${threshold}-of-${N} (M-of-N quorum)`);
	console.log(`  channel name (share this):  ${channel}`);
	console.log(`  relayers run a node with:   GAVL_FEED_URL=http://localhost:${port}/`);
	console.log(`  serving signed updates on:  http://localhost:${port}/\n`);
	void tick();
	setInterval(() => void tick(), everyMs);
});
