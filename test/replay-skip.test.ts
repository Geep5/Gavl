/**
 * Replay skips the expensive VDF re-check (so a large persisted backlog doesn't block boot) WITHOUT
 * dropping integrity. A write's `id` binds its time proof and its signature binds the `id`, so the
 * sig/id checks still catch any tampering — `skipTimeProof` only bypasses re-walking the O(iters)
 * cooldown for writes that already passed full verification before they were persisted.
 *
 *   node --test test/replay-skip.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../src/ledger/ledger.ts";
import { makeChain, PARAMS } from "./helpers.ts";
import type { Vdf } from "../src/pot/vdf.ts";

// A VDF whose verify REJECTS every proof — stands in for the real (expensive) verify that boot
// replay must not run. eval is never called here (we only apply pre-made writes).
const rejectAllVdf: Vdf = { name: "reject-all", eval: async () => ({ iters: 1, output: "", proof: "" }), verify: () => false };

test("live apply runs the VDF verify (rejects); replay with skipTimeProof applies the same writes", async () => {
	const { writes } = await makeChain(3); // real signed writes with genuine HashVdf cooldowns
	const params = { ...PARAMS, vdf: rejectAllVdf }; // same difficulty/dcf/floor, but verify says no

	// live/gossip path: the VDF verify runs → a write whose proof this VDF rejects is refused
	const live = new Ledger(params);
	const lr = live.apply(writes[0]);
	assert.equal(lr.ok, false, "live path runs the VDF verify");
	assert.match(lr.reason ?? "", /time proof/, "rejected on the time proof");

	// replay path: skipTimeProof bypasses the VDF re-check → the already-accepted writes apply
	const replay = new Ledger(params);
	for (const w of writes) {
		const r = replay.apply(w, { skipTimeProof: true });
		assert.equal(r.ok, true, `replay applied seq ${w.seq}`);
	}
});

test("skipTimeProof still rejects tampered writes — integrity is preserved", async () => {
	const { writes } = await makeChain(2);
	const params = { ...PARAMS, vdf: rejectAllVdf };

	// a flipped signature must fail even on the replay path
	const badSig = { ...writes[0], sig: writes[0].sig.replace(/^./, (c) => (c === "a" ? "b" : "a")) };
	assert.equal(new Ledger(params).apply(badSig, { skipTimeProof: true }).ok, false, "tampered signature rejected under skip");

	// a tampered time.output (changes nothing the sig/id committed to → id no longer matches) fails too
	const badTime = { ...writes[0], time: { ...writes[0].time, output: "00".repeat(32) } };
	assert.equal(new Ledger(params).apply(badTime, { skipTimeProof: true }).ok, false, "tampered proof breaks the id/sig binding even under skip");
});
