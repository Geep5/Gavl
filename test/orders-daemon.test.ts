/**
 * The daemon wiring of the order board: ops posted through the active identity land on the board
 * once certified, the producer commits the folded board (its own anchors pass the appRoot check, so
 * the chain keeps growing), a checkpoint carries the real board and authenticates against its child
 * anchor's appRoot, folds resume from it, and the proof deadline fires on the anchor clock.
 *
 *   node --test test/orders-daemon.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deserializeView, viewRoot } from "../src/market/state.ts";
import { PROOF_WINDOW } from "../src/market/fold.ts";
import { swapSecretHash, takeSwapId } from "../src/swap/keys.ts";
import { toHex } from "../src/det/canonical.ts";
import { PARAMS, K, waitFor } from "./helpers.ts";

// Dynamic on purpose: the daemon reads GAVL_CHECKPOINT_EVERY at module load, so the env must be set first.
process.env.GAVL_CHECKPOINT_EVERY = "4";
const { Daemon } = await import("../src/daemon.ts");

test("daemon: post, take, commit, checkpoint, and the proof deadline on the anchor clock", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gavl-orders-"));
	const d = new Daemon({ walletDir: dir, params: PARAMS, k: K, heartbeatMs: 100, network: "orders-daemon-test" });
	try {
		await d.startConsensus({ mesh: false, farm: true });
		const tipHeight = () => d.consensus().tip?.height ?? 0;

		const { offerId } = await d.postOffer({ give: { chain: "bitcoin", amount: "1000000" }, want: { chain: "litecoin", amount: "40000000" }, minFill: "100000" });
		await waitFor(() => d.offers().offers.some((o) => o.id === offerId), 20_000);
		const listed = d.offers().offers.find((o) => o.id === offerId)!;
		assert.equal(listed.remaining, "1000000");
		assert.equal(listed.expiresAt - listed.postedAt, 1440, "default TTL: 24h of anchors");

		await assert.rejects(d.postOffer({ give: { chain: "bitcoin", amount: "1000000" }, want: { chain: "bitcoin", amount: "1" }, minFill: "1" }), /malformed offer.post/);
		await assert.rejects(d.takeOffer(offerId, "100000"), /cannot take its own offer/);

		const taker = d.createAccount("taker"); // becomes the active identity
		await assert.rejects(d.takeOffer(offerId, "99999"), /below the offer's minimum/);
		await assert.rejects(d.cancelOffer(offerId), /only the maker/);
		const { matchId, hash } = await d.takeOffer(offerId, "250000");
		await waitFor(() => d.matches(true).matches.some((m) => m.id === matchId), 20_000);
		const m = d.matches(true).matches.find((x) => x.id === matchId)!;
		assert.equal(m.taker, taker.pubHex);
		assert.equal(m.takerAmount, "10000000");
		assert.equal(hash, toHex(swapSecretHash(taker.keypair.privateKey, takeSwapId(offerId, taker.pubHex, m.takeSeq))), "re-derivable from the match record");
		assert.equal(d.offers().offers.find((o) => o.id === offerId)!.remaining, "750000");

		// Nobody proves funds → cancelled at the deadline, capacity restored — all on the anchor clock.
		await waitFor(() => tipHeight() > m.proofDeadline, 30_000);
		const after = d.matches(false).matches.find((x) => x.id === matchId)!;
		assert.deepEqual(after.cancelled, { at: m.proofDeadline + 1, reason: "noProof" });
		assert.equal(m.proofDeadline, m.takenAt + PROOF_WINDOW);
		assert.equal(d.offers().offers.find((o) => o.id === offerId)!.remaining, "1000000");

		// A checkpoint past the take carries the real board and authenticates against its child's appRoot.
		const snap = () => d.node.fullSnapshot?.() ?? null; // the checkpoint this node serves to fresh peers
		await waitFor(() => (snap()?.height ?? 0) > m.takenAt, 30_000);
		const s = snap()!;
		const state = deserializeView(s.state);
		assert.ok(state.offers.has(offerId) && state.matches.has(matchId), "checkpoint holds the board");
		const anchors = d.node.anchors!;
		const child = anchors.chainTo().find((a) => a.prev === s.anchorId)!;
		assert.equal(child.appRoot, viewRoot(state), "the child anchor commits the checkpointed board");

		// Folds now resume from the checkpoint; the producer's anchors must still pass verifyState.
		const h0 = tipHeight();
		await waitFor(() => tipHeight() >= h0 + 3, 20_000);
		assert.equal(d.offers().offers.find((o) => o.id === offerId)!.remaining, "1000000");
	} finally {
		await d.stop();
		rmSync(dir, { recursive: true, force: true });
	}
});
