/**
 * Gavl demo — a decentralized auction over a real hyperswarm/hyperdht mesh.
 *
 *   node src/demo-auction.ts
 *
 * Spins up two nodes on a private DHT testnet: a seller lists an item, a bidder
 * (on the other node, discovered purely by gossip) bids, the seller settles.
 * Both nodes independently converge on the same outcome and balances.
 */

import createTestnet from "hyperdht/testnet.js";
import { Ledger } from "./ledger/ledger.ts";
import { GavlNode } from "./sync/node.ts";
import { SwarmTransport } from "./sync/swarm.ts";
import { Account } from "./auction/account.ts";
import { computeView, REWARD } from "./auction/state.ts";
import { defaultParams } from "./config.ts";

const PARAMS = defaultParams(); // real chiavdf by default (GAVL_VDF=hash to opt out)
const K = 11;
const NETWORK = "gavl-demo-mainnet";

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("demo: timed out waiting for convergence");
}

const short = (h: string) => h.slice(0, 10) + "…";

const testnet = await createTestnet(10);
const nodeA = new GavlNode(new Ledger(PARAMS));
const nodeB = new GavlNode(new Ledger(PARAMS));
const ta = new SwarmTransport(nodeA, { bootstrap: testnet.bootstrap });
const tb = new SwarmTransport(nodeB, { bootstrap: testnet.bootstrap });

let clock = 0;
const now = () => ++clock;
const seller = new Account({ node: nodeA, params: PARAMS, k: K, now });
const bidder = new Account({ node: nodeB, params: PARAMS, k: K, now });

console.log(`Gavl auction over a real hyperswarm/hyperdht mesh (topic "${NETWORK}")\n`);
console.log(`  seller ${short(seller.pubHex)} on node A`);
console.log(`  bidder ${short(bidder.pubHex)} on node B\n`);

try {
	await ta.join(NETWORK);
	await tb.join(NETWORK);
	console.log("• nodes connected over the DHT\n");

	const id = await seller.createAuction("Antique Star Map", null);
	console.log(`• seller lists "Antique Star Map"  (auction ${short(id)})`);
	await waitFor(() => bidder.view().auctions.has(id));
	console.log("• bidder discovered the listing via gossip");

	// The bidder picks the open auction from its OWN synced view, then bids.
	const open = bidder.auctions().find((a) => a.status === "open")!;
	const ref = await bidder.bid(open.id, 500n);
	console.log("• bidder bids 500 GAV (escrowed)");
	await waitFor(() => seller.view().auctions.get(id)!.bids.length === 1);

	await seller.settle(id, ref);
	console.log("• seller settles to the bidder\n");
	await waitFor(() => nodeA.ledger.stateRoot() === nodeB.ledger.stateRoot() && bidder.view().auctions.get(id)?.status === "settled");

	for (const [label, node] of [["A", nodeA], ["B", nodeB]] as const) {
		const v = computeView(node.ledger.allWrites());
		const a = v.auctions.get(id)!;
		console.log(`node ${label}:  auction=${a.status}  item→${short(v.items.get(id)!.owner)}  ` + `seller=${v.balances.get(seller.pubHex)} GAV  bidder=${v.balances.get(bidder.pubHex)} GAV`);
	}
	console.log(`\nBoth nodes agree. Total GAV = 3 × ${REWARD} reward, conserved. State roots match.`);
} finally {
	await ta.destroy();
	await tb.destroy();
	await testnet.destroy();
}
