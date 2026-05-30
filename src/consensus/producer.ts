/**
 * Producer — the anchor "farming" loop.
 *
 * Repeatedly mines an anchor extending the node's current heaviest tip and
 * committing the node's current ledger heads, then submits it (gossiped if it
 * becomes the new tip). Production is PoST-cooldown-gated, and with real chiapos
 * a plot may yield no proof for a given challenge — `produceOne` returns null
 * then, and the loop simply tries the next challenge. Because each round builds
 * on the latest tip, honest producers converge rather than fork apart.
 */

import { mineAnchor } from "./anchor.ts";
import type { Anchor } from "./anchor.ts";
import type { SpaceProver } from "./space.ts";
import type { KeyPair } from "../det/ed25519.ts";
import type { ChainParams } from "../chain/writer.ts";
import type { GavlNode } from "../sync/node.ts";

export interface ProducerOptions {
	node: GavlNode;
	keypair: KeyPair;
	prover: SpaceProver;
	params: ChainParams;
}

export class Producer {
	private readonly node: GavlNode;
	private readonly keypair: KeyPair;
	private readonly prover: SpaceProver;
	private readonly params: ChainParams;
	private active = false;

	constructor(opts: ProducerOptions) {
		this.node = opts.node;
		this.keypair = opts.keypair;
		this.prover = opts.prover;
		this.params = opts.params;
	}

	/** Mine + submit one anchor over the current tip + heads. Null if no proof this round. */
	async produceOne(): Promise<Anchor | null> {
		const anchor = await mineAnchor({
			prev: this.node.anchorTip(),
			producer: this.keypair,
			prover: this.prover,
			heads: this.node.ledger.heads(),
			params: this.params,
		});
		if (anchor) await this.node.submitAnchor(anchor);
		return anchor;
	}

	async run(opts: { until: () => boolean; paceMs?: number }): Promise<void> {
		this.active = true;
		while (this.active && !opts.until()) {
			await this.produceOne();
			await new Promise((r) => setImmediate(r));
			if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
		}
	}

	stop(): void {
		this.active = false;
	}
}
