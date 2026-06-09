/**
 * Gavl demo — live consensus over a real hyperswarm/hyperdht mesh.
 *
 *   node src/demo-consensus.ts
 *
 * Two nodes run an auction AND farm anchors. Anchors gossip over the same mesh
 * as writes; both nodes converge on the heaviest anchor chain and the same
 * FINALIZED auction outcome — end-to-end decentralized consensus, no servers.
 */

import createTestnet from "hyperdht/testnet.js";
import { Ledger } from "./ledger/ledger.ts";
import { GavlNode } from "./sync/node.ts";
import { SwarmTransport } from "./sync/swarm.ts";
import { AnchorChain } from "./consensus/chain.ts";
import { Producer } from "./consensus/producer.ts";
import { StandinSpaceProver, StandinSpaceVerifier } from "./consensus/space.ts";
import { finalizedView, gbtcOf } from "./market/btc.ts";
import { Account } from "./market/account.ts";
import { bridgeKeyPair } from "./market/oracle.ts";
import { Writer } from "./chain/writer.ts";
import { defaultParams } from "./config.ts";

const PARAMS = defaultParams(); // real chiavdf by default (GAVL_VDF=hash to opt out)
const K = 11;
const NETWORK = "gavl-consensus-mainnet";
const FINALITY = 1;

const short = (h: string) => h.slice(0, 10) + "…";
async function waitFor(pred: () => boolean, ms = 30_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error("demo: timed out");
}

const testnet = await createTestnet(10);
const verifier = new StandinSpaceVerifier();
const nodeA = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, verifier));
const nodeB = new GavlNode(new Ledger(PARAMS), new AnchorChain(PARAMS, verifier));
const ta = new SwarmTransport(nodeA, { bootstrap: testnet.bootstrap });
const tb = new SwarmTransport(nodeB, { bootstrap: testnet.bootstrap });

let clock = 0;
const now = () => ++clock;
const alice = new Account({ node: nodeA, params: PARAMS, k: K, now });
const attestor = new Account({ node: nodeA, params: PARAMS, k: K, now, keypair: bridgeKeyPair() }); // bridge attestor

// Node A farms anchors; node B follows the chain purely via gossip. (The real
// chiavdf eval blocks the event loop via spawnSync, so running two in-process
// farmers would starve gossip — and "some nodes farm, others follow" is the
// realistic topology anyway. Two-farmer convergence is covered in the tests.)
const farmA = new Writer({ k: K, params: PARAMS });
const prodA = new Producer({ node: nodeA, keypair: farmA.keypair, prover: new StandinSpaceProver(farmA.plot), params: PARAMS });

const gbtcFinal = (node: GavlNode): bigint => gbtcOf(finalizedView(node.ledger.allWrites(), node.anchors!, FINALITY), alice.pubHex);

console.log(`Gavl live consensus over a real hyperdht mesh (topic "${NETWORK}")\n`);

let stop = false;
try {
	await ta.join(NETWORK);
	await tb.join(NETWORK);
	console.log("• two nodes connected over the DHT\n");

	// The bridge attestor (on node A) mints alice 3000 gBTC from a verified deposit.
	// The signed write gossips to node B.
	await attestor.attestDeposit("demo-dep:0", alice.pubHex, 3000n);
	await waitFor(() => gbtcOf(nodeB.view(), alice.pubHex) === 3000n);
	console.log(`• alice credited 3000 gBTC (bridge deposit gossiped to node B)\n`);

	console.log(`• node A farms anchors (real ${PARAMS.vdf.name} cooldown); node B follows via gossip…`);
	const farming = prodA.run({ until: () => stop, paceMs: 120 });

	// Wait until the chain is a few anchors deep (finality real), B has caught up to
	// A's heaviest tip, and both have FINALIZED alice's 3000 gBTC.
	await waitFor(() => {
		const ta2 = nodeA.anchorTip();
		const tb2 = nodeB.anchorTip();
		return !!ta2 && !!tb2 && ta2.id === tb2.id && ta2.height >= 2 && gbtcFinal(nodeA) === 3000n && gbtcFinal(nodeB) === 3000n;
	});

	stop = true;
	await farming;

	const tip = nodeA.anchorTip()!;
	console.log(`\n• converged: heaviest anchor tip height ${tip.height}, id ${short(tip.id)}, weight ${tip.weight}\n`);
	for (const [label, node] of [["A", nodeA], ["B", nodeB]] as const) {
		console.log(`node ${label}:  tip=${short(node.anchorTip()!.id)}  finalized alice gBTC = ${gbtcFinal(node)}`);
	}
	console.log("\nA farmed, B followed by gossip, and both finalized the SAME gBTC balance. Consensus is live.");
} finally {
	stop = true;
	await ta.destroy();
	await tb.destroy();
	await testnet.destroy();
}
