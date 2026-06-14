/**
 * Offer cover-check — the gossip tape only keeps offers their maker can actually back (the
 * match-time ghost-check, applied at gossip ingest). Unfunded spam is dropped on arrival for
 * free, and every kept offer is tied to real gBTC, so the tape self-bounds to the funded
 * economy with no cap. Tested on a bare in-memory daemon (no mesh, no store, fast params).
 *
 *   node --test test/offer-cover-check.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { Daemon } from "../src/daemon.ts";
import { Account } from "../src/market/account.ts";
import { bridgeKeyPair } from "../src/market/oracle.ts";
import { PARAMS, K } from "./helpers.ts";

let n = 0;
const freshDir = () => join(tmpdir(), `gavl-cover-${process.pid}-${n++}`);

test("you can't broadcast an offer you can't back", async () => {
	const dir = freshDir();
	try {
		const d = new Daemon({ walletDir: dir, params: PARAMS }); // fresh wallet → active account holds 0 gBTC
		assert.throws(() => d.broadcastIntent("long", "1000", "2"), /insufficient gBTC/, "unfunded broadcast is refused");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a gossiped offer is kept only if its maker can back it", async () => {
	const dir = freshDir();
	try {
		const d = new Daemon({ walletDir: dir, params: PARAMS });
		let t = 0;
		const now = () => ++t;
		const attestor = new Account({ node: d.node, params: PARAMS, k: K, now, keypair: bridgeKeyPair() });
		const maker = new Account({ node: d.node, params: PARAMS, k: K, now }); // will be funded
		const ghost = new Account({ node: d.node, params: PARAMS, k: K, now }); // never funded
		await attestor.attestDeposit("dep0:0", maker.pubHex, 5000n);

		const backed = maker.makeOffer({ makerSide: "long", size: "1000", leverage: "2", expiryHeight: 9_999_999, nonce: "ok" });
		const unbacked = ghost.makeOffer({ makerSide: "long", size: "1000", leverage: "2", expiryHeight: 9_999_999, nonce: "ghost" });

		assert.equal(d.node.onIntent?.(unbacked), false, "an unbacked offer is dropped on arrival (not kept, not re-gossiped)");
		assert.equal(d.node.onIntent?.(backed), true, "a backed offer is kept + re-gossiped");

		// And a funded maker can't over-commit beyond their balance across multiple resting offers.
		const over = maker.makeOffer({ makerSide: "long", size: "5000", leverage: "2", expiryHeight: 9_999_999, nonce: "over" });
		assert.equal(d.node.onIntent?.(over), false, "5000 more would exceed the maker's 5000 balance already committed to 'ok' (1000) → dropped");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
