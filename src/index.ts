/**
 * Gavl P0 demo — Chia-style Proof-of-Space-Time cooldown chain.
 *
 *   node src/index.ts
 *
 * Watch the cooldown track plot size: the bigger plot writes sooner.
 */

import { Writer, verifyWrite } from "./chain/writer.ts";
import { defaultParams } from "./config.ts";

// Real chiavdf by default (GAVL_VDF=hash for the stand-in). Tuned for the space→rate demo.
const params = defaultParams({ difficulty: 160n, floorIters: 2_000n });

console.log(`Gavl P0 — PoST cooldown chain (vdf=${params.vdf.name}, difficulty=${params.difficulty}, dcf=2^20)\n`);

for (const k of [11, 14]) {
	const w = new Writer({ k, params });
	console.log(`identity ${w.pubHex.slice(0, 12)}…  plot 2^${k} (${(2 ** k).toLocaleString()} leaves)`);

	let prev: string | null = null;
	let seq = 0;
	const stateRoot = "00".repeat(32);
	for (const payload of [{ op: "create", item: "sword" }, { op: "bid", offer: 50 }, { op: "settle" }]) {
		const t0 = process.hrtime.bigint();
		const wr = await w.write({ prev, seq, stateRoot, payload, ts: 1_700_000_000 + seq });
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		const v = verifyWrite(wr, params);
		console.log(
			`  seq ${wr.seq}  ${JSON.stringify(payload).padEnd(28)}  ` +
				`iters ${String(wr.time.iters).padStart(7)}  ${ms.toFixed(0).padStart(4)}ms  ${v.ok ? "✓" : "✗ " + v.reason}`,
		);
		prev = wr.id;
		seq++;
	}
	console.log();
}

console.log("Same difficulty, larger plot → smaller required iters → shorter cooldown. Space buys throughput.");
