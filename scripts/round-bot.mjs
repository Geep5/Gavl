#!/usr/bin/env node
// A minimal external agent for Gavl Rounds — a momentum bot over the plain HTTP API. Self-contained
// on purpose (no imports from the codebase): this is the template for wiring ANY brain — indicator
// stacks, rules, an LLM — to the one verb, POST /api/round/enter. See docs/agents.md.
//
//   node scripts/round-bot.mjs
//   GAVL_API=http://127.0.0.1:6450 STAKE=5000 MIN_MOVE_BPS=15 node scripts/round-bot.mjs

const API = process.env.GAVL_API ?? "http://127.0.0.1:6440";
const STAKE = process.env.STAKE ?? "1000";
const MIN_MOVE_BPS = Number(process.env.MIN_MOVE_BPS ?? "10");

const samples = []; // [{h, p}] one mark sample per anchor — the bot's own price memory
let lastEntered = -1;

const log = (m) => console.log(`[round-bot] ${m}`);

async function tick() {
	const s = await fetch(`${API}/api/state`).then((r) => r.json());
	const R = s.market?.rounds;
	const price = s.market?.price ? BigInt(s.market.price) : null;
	if (!R || price === null) return log("waiting for a market…");

	// remember one price per anchor (that's the momentum signal)
	if (samples.length === 0 || samples[samples.length - 1].h !== R.tip) {
		samples.push({ h: R.tip, p: price });
		if (samples.length > 120) samples.shift();
	}

	const r = R.entering;
	if (!R.entryOpen || r.idx === lastEntered || r.mySide) return; // locked, done, or already in
	if (r.locksAt - 1 - R.tip > 3) return; // enter late — within ~3 anchors of the cutoff

	// the brain (swap this for anything): move over ~one round, in bps
	const then = samples.filter((x) => x.h <= R.tip - R.len).at(-1);
	if (!then) return log(`round #${r.idx}: not enough price history yet`);
	const moveBps = Number(((price - then.p) * 10_000n) / then.p);
	if (Math.abs(moveBps) < MIN_MOVE_BPS) return log(`round #${r.idx}: move ${moveBps} bps < ${MIN_MOVE_BPS} — skip`);
	const side = moveBps > 0 ? "up" : "down";

	const res = await fetch(`${API}/api/round/enter`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ side, stake: STAKE, idx: r.idx }),
	}).then((x) => x.json());
	if (res.error) return log(`round #${r.idx}: rejected — ${res.error}`);
	lastEntered = r.idx;
	log(`entered round #${r.idx} ${side.toUpperCase()} with ${STAKE} gBTC (move ${moveBps} bps)`);
}

log(`watching ${API} — stake ${STAKE}, threshold ${MIN_MOVE_BPS} bps`);
setInterval(() => tick().catch((e) => log(`error: ${e.message}`)), 5_000);
