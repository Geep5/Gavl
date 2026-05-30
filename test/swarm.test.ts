/**
 * P1 — convergence over the REAL Holepunch mesh (hyperswarm + hyperdht).
 *
 * Uses an in-process hyperdht testnet (a private DHT) so the test is offline and
 * deterministic, but exercises the actual hyperswarm discovery + Noise sockets
 * + our length-prefixed framing — not the in-memory shim.
 *
 *   node --test test/swarm.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import createTestnet from "hyperdht/testnet.js";

import { Ledger } from "../src/ledger/ledger.ts";
import { GavlNode } from "../src/sync/node.ts";
import { SwarmTransport } from "../src/sync/swarm.ts";
import { makeChain, PARAMS, waitFor } from "./helpers.ts";

const NETWORK = "gavl-swarm-test-v1";

test("two nodes converge over a real hyperswarm mesh", { timeout: 40_000 }, async () => {
	const testnet = await createTestnet(3);

	const a = new GavlNode(new Ledger(PARAMS));
	const b = new GavlNode(new Ledger(PARAMS));
	const ta = new SwarmTransport(a, { bootstrap: testnet.bootstrap });
	const tb = new SwarmTransport(b, { bootstrap: testnet.bootstrap });

	// A starts with a 3-write chain; B starts empty.
	const { writes } = await makeChain(3);
	for (const w of writes) a.submit(w);

	try {
		// Join sequentially: A announces and settles into the DHT before B looks it
		// up — the realistic "A is already on the network when B arrives" ordering.
		await ta.join(NETWORK);
		await tb.join(NETWORK);
		await waitFor(() => b.ledger.summary().writes === 3 && b.ledger.stateRoot() === a.ledger.stateRoot(), 25_000);

		assert.equal(b.ledger.summary().writes, 3, "B pulled A's chain over the mesh");
		assert.equal(a.ledger.stateRoot(), b.ledger.stateRoot(), "stateRoots match ⇒ in sync");
	} finally {
		await ta.destroy();
		await tb.destroy();
		await testnet.destroy();
	}
});
