/**
 * Custody share persistence (gate #2, #1) — a node's distributed-DKG share survives
 * disk round-trip, and reloaded shares still threshold-sign. Proves the persistence
 * layer that lets a committee node co-sign across restarts.
 *
 *   node --test test/custody-share-store.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { MemoryNetwork } from "../src/sync/memory.ts";
import { DkgCoordinator } from "../src/custody/dkg-coordinator.ts";
import { saveShare, loadShare } from "../src/custody/share-store.ts";
import type { StoredShare } from "../src/custody/share-store.ts";
import { thresholdSign, verify } from "../src/custody/threshold.ts";
import { taprootOutputKey, verifyWithdrawal } from "../src/custody/bitcoin.ts";
import { schnorr_FROST } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PARAMS } from "./helpers.ts";

test("a committee node's share persists to disk and reloads intact", () => {
	const ids = ["A", "B", "C"];
	const net = new MemoryNetwork();
	const nodes = Object.fromEntries(ids.map((id) => [id, new GavlNode(new Ledger(PARAMS))]));
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) net.link(nodes[ids[i]], nodes[ids[j]]);

	return (async () => {
		const coords = ids.map((id) => new DkgCoordinator(nodes[id], { session: "fund", selfId: id, participants: ids, min: 2 }));
		const starts = coords.map((c) => c.start());
		await net.idle();
		const results = await Promise.all(starts);

		// each node persists ONLY its own share to its own store
		const dir = mkdtempSync(join(tmpdir(), "gavl-share-"));
		ids.forEach((id, i) => {
			const stored: StoredShare = { ...results[i], session: "fund", participants: ids, min: 2 };
			saveShare(join(dir, `${id}.json`), stored);
		});

		// reload and check the FROST binary round-tripped exactly
		const reloaded = ids.map((id) => loadShare(join(dir, `${id}.json`))!);
		for (let i = 0; i < ids.length; i++) {
			assert.equal(Buffer.compare(reloaded[i].share.signingShare, results[i].share.signingShare), 0, "share bytes intact");
			assert.equal(Buffer.compare(reloaded[i].groupPubKey, results[0].groupPubKey), 0, "group key intact + agreed");
		}

		// a quorum of the RELOADED shares still produces a Bitcoin-valid signature
		const fidOf = (id: string) => schnorr_FROST.Identifier.derive(id);
		const shares = { [fidOf("A")]: reloaded[0].share, [fidOf("B")]: reloaded[1].share };
		const msg = sha256(new TextEncoder().encode("sign after restart"));
		const sig = thresholdSign(msg, reloaded[0].pub, shares);
		assert.equal(verify(sig, msg, reloaded[0].groupPubKey), true, "reloaded shares threshold-sign");
		assert.equal(verifyWithdrawal(sig, msg, taprootOutputKey(reloaded[0].groupPubKey)), true, "Bitcoin accepts it");
	})();
});

test("loadShare returns null when nothing is persisted", () => {
	const dir = mkdtempSync(join(tmpdir(), "gavl-share-"));
	assert.equal(loadShare(join(dir, "nope.json")), null);
});
