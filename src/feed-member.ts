/**
 * Gavl feed member — ONE independent signer in a decentralized M-of-N price set.
 *
 * This is the real version of an M-of-N feed: each member runs THIS process on its own machine,
 * holding only its OWN key and reading its OWN price source. It never serves a price and never
 * trusts a coordinator's number — it answers a co-sign request only when the proposed reading is
 * fresh AND within tolerance of what it just fetched itself. A quorum forms only when ≥ M members
 * each independently agree, so no aggregator (and no minority of members) can forge a price.
 *
 * Protocol (the aggregator drives it — see feed-aggregator.ts):
 *   GET  /            → { pubkey }                      // this member's identity (its set key)
 *   POST /sign  {price,expo,publishTime}  → { signer, sig }   // co-signed iff it agrees
 *                                          → 409 { error }     // refused (stale / off-tolerance)
 *
 * Run it (one per member, each on its own host/key):
 *   node src/feed-member.ts \
 *     --upstream "https://api.coinbase.com/v2/prices/BTC-USD/spot" \
 *     --path data.amount --expo -2 --key ~/.gavl/member-a.json --port 8788 --tolerance-bps 50
 *
 *   --upstream <url>       THIS member's own price endpoint (GET, JSON) — read independently
 *   --path <a.b.c>         dot-path to the price within the JSON
 *   --expo <n>             decimal exponent; must match the set's (real price = integer · 10^expo)
 *   --key <file>           this member's keyfile (load/create; default ~/.gavl/feed-key.json)
 *   --port <n>             HTTP port the aggregator reaches this member on (default 8788)
 *   --tolerance-bps <n>    max deviation from this member's own price to co-sign (default 50 = 0.5%)
 *   --max-skew <sec>       max publish-time skew from now to co-sign (default 60)
 *
 * It prints this member's PUBLIC KEY — give it to whoever assembles the set (the aggregator), so the
 * channel can commit `signerSetHash({threshold, [all member pubkeys]})`.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { generateKeyPair, keyPairFromSeed } from "./det/ed25519.ts";
import { toHex, fromHex } from "./det/canonical.ts";
import { signReading } from "./market/signed-feed.ts";
import { readUpstreamPrice, memberApproves, type Proposal } from "./market/feed-source.ts";

// ── flags ────────────────────────────────────────────────────────────────
function flag(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const upstream = flag("upstream");
const pricePath = flag("path");
const expo = Number(flag("expo", "-8"));
const keyFile = (flag("key", path.join(os.homedir(), ".gavl", "feed-key.json")) as string).replace(/^~(?=$|\/)/, os.homedir());
const port = Number(flag("port", "8788"));
const toleranceBps = Number(flag("tolerance-bps", "50"));
const maxSkewSec = Number(flag("max-skew", "60"));

if (!upstream || !pricePath || !Number.isInteger(expo)) {
	console.error("usage: node src/feed-member.ts --upstream <url> --path <a.b.c> --expo <n> [--key FILE] [--port N] [--tolerance-bps N] [--max-skew SEC]");
	process.exit(1);
}

/** Load this member's Ed25519 key, or generate + persist a new one (0600, seed only). */
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

const key = loadOrCreateKey(keyFile);
const pubkey = toHex(key.publicKey);

// ── read a small JSON body (capped) ────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let buf = "";
		req.on("data", (c) => {
			buf += c;
			if (buf.length > 64 * 1024) reject(new Error("body too large")); // a proposal is tiny
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(buf || "{}"));
			} catch (e) {
				reject(e as Error);
			}
		});
		req.on("error", reject);
	});
}

const server = http.createServer(async (req, resp) => {
	resp.setHeader("content-type", "application/json");
	resp.setHeader("access-control-allow-origin", "*");

	// identity — the aggregator learns this member's set key here
	if (req.method === "GET" && (req.url === "/" || req.url === "/pubkey")) {
		resp.end(JSON.stringify({ pubkey }));
		return;
	}

	// co-sign a proposal IFF this member independently agrees
	if (req.method === "POST" && req.url === "/sign") {
		let p: Proposal;
		try {
			p = (await readBody(req)) as Proposal;
		} catch {
			resp.statusCode = 400;
			resp.end(JSON.stringify({ error: "bad request body" }));
			return;
		}
		if (typeof p?.price !== "string" || typeof p.expo !== "number" || typeof p.publishTime !== "number") {
			resp.statusCode = 400;
			resp.end(JSON.stringify({ error: "expected {price,expo,publishTime}" }));
			return;
		}
		if (p.expo !== expo) {
			resp.statusCode = 409;
			resp.end(JSON.stringify({ error: `expo mismatch (mine ${expo}, proposed ${p.expo})` }));
			return;
		}
		// fetch MY OWN price, right now, and decide for myself
		const ownPrice = await readUpstreamPrice(upstream!, pricePath!, expo);
		if (ownPrice == null) {
			resp.statusCode = 503;
			resp.end(JSON.stringify({ error: "my upstream is unavailable — won't sign blind" }));
			return;
		}
		const verdict = memberApproves(p, ownPrice, { toleranceBps, nowSec: Math.floor(Date.now() / 1000), maxSkewSec });
		if (!verdict.ok) {
			resp.statusCode = 409;
			resp.end(JSON.stringify({ error: verdict.reason }));
			console.log(`  refused: ${verdict.reason}`);
			return;
		}
		const sig = signReading(BigInt(p.price), p.expo, p.publishTime, key.privateKey);
		resp.end(JSON.stringify({ signer: pubkey, sig }));
		console.log(`  co-signed ${p.price}e${p.expo} (t=${p.publishTime}) — agreed with my ${ownPrice}`);
		return;
	}

	resp.statusCode = 404;
	resp.end(JSON.stringify({ error: "not found" }));
});

server.listen(port, () => {
	console.log(`\nGavl feed member — independent signer over ${upstream}`);
	console.log(`  my public key (give to the aggregator):  ${pubkey}`);
	console.log(`  tolerance: ${toleranceBps}bps · max skew: ${maxSkewSec}s`);
	console.log(`  serving identity + co-sign on:           http://localhost:${port}/\n`);
});
