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
	/** App-state commitment for an anchor extending `prev` (the appRoot it carries). Supplied
	 *  by the app (the consensus layer can't fold app state). Omit → anchors carry "". */
	appRootFor?: (prev: Anchor | null) => string;
}

export class Producer {
	private readonly node: GavlNode;
	private readonly keypair: KeyPair;
	private readonly prover: SpaceProver;
	private readonly params: ChainParams;
	private readonly appRootFor?: (prev: Anchor | null) => string;
	private active = false;

	constructor(opts: ProducerOptions) {
		this.node = opts.node;
		this.keypair = opts.keypair;
		this.prover = opts.prover;
		this.params = opts.params;
		this.appRootFor = opts.appRootFor;
	}

	/** Mine + submit one anchor over the current tip + heads. Null if no proof this round.
	 *  Mines at the difficulty the chain expects for this tip (retargeted if a schedule
	 *  is set) — so the per-anchor VDF cost IS the pace, not a software timer. */
	async produceOne(): Promise<Anchor | null> {
		const prev = this.node.anchorTip();
		const difficulty = this.node.anchors?.difficultyFor(prev) ?? this.params.difficulty;
		const anchor = await mineAnchor({
			prev,
			prevHeads: prev ? this.node.anchors?.headsAt(prev.id) : {}, // full heads the tip certified → diff for the delta
			producer: this.keypair,
			prover: this.prover,
			heads: this.node.ledger.heads(),
			params: this.params,
			difficulty,
			appRoot: this.appRootFor?.(prev), // commit the state prev certified (lag-by-parent)
		});
		if (anchor) await this.node.submitAnchor(anchor);
		return anchor;
	}

	/**
	 * Farm until `until()`. The cooldown (VDF) is the real pace; `paceMs` is only a
	 * cooperative yield to keep tiny stand-in-VDF demos from spinning the CPU — it
	 * is NOT a consensus rule and an attacker dropping it gains nothing once the
	 * difficulty schedule sets a meaningful per-anchor VDF cost.
	 */
	async run(opts: { until: () => boolean; paceMs?: number }): Promise<void> {
		this.active = true;
		while (this.active && !opts.until()) {
			await this.produceOne();
			await new Promise((r) => setImmediate(r));
			if (opts.paceMs) await new Promise((r) => setTimeout(r, opts.paceMs));
		}
	}

	/**
	 * Adaptive farming — work tracks activity instead of running flat-out.
	 *
	 *  - BUSY: while the ledger has writes the chain hasn't yet finalized, farm
	 *    back-to-back (paced only by the VDF) to bury them to finality.
	 *  - IDLE: once everything that has happened is finalized, drop to a slow
	 *    HEARTBEAT — one anchor every `heartbeatMs` — so a trickle of weight keeps
	 *    accruing (fresh-node bootstrap safety) without burning compute on empty
	 *    anchors. A new action makes the ledger heads advance → back to BUSY.
	 *  - BOOTSTRAP: an optional `bootstrapping()` predicate forces BUSY even when idle.
	 *    Before the first committee exists, the genesis ceremony can't run until the chain
	 *    reaches its first epoch boundary — but with no writes to bury, plain IDLE would
	 *    crawl there one empty anchor per `heartbeatMs` (~32 min at 16 anchors × 120s).
	 *    While `bootstrapping()` is true we sprint at busyPaceMs to reach genesis; it flips
	 *    false the moment the fund key is published, reverting to IDLE so an up network never
	 *    burns compute. (The VDF cost still self-paces each anchor — this is a yield, not a spin.)
	 *
	 * `finalityDepth` is the depth at which we consider activity buried (matches the
	 * chain's sticky-finality lock). Online nodes are already safe via that lock;
	 * the heartbeat is purely for long-range/bootstrap weight.
	 */
	async runAdaptive(opts: { until: () => boolean; finalityDepth: number; busyPaceMs?: number; bootstrapPaceMs?: number; heartbeatMs?: number; bootstrapping?: () => boolean }): Promise<void> {
		this.active = true;
		const heartbeatMs = opts.heartbeatMs ?? 120_000;
		let lastAnchorAt = 0;
		while (this.active && !opts.until()) {
			const chain = this.node.anchors;
			const heads = this.node.ledger.heads();
			const caughtUp = chain ? chain.headsCovered(heads, opts.finalityDepth) : true;

			// Busy if there are unfinalized writes to bury, OR we're still bootstrapping (no committee
			// yet) and must sprint empty anchors to the genesis epoch boundary instead of crawling at
			// the idle heartbeat.
			if (!caughtUp || opts.bootstrapping?.()) {
				// Busy: bury outstanding writes as fast as the cooldown allows.
				await this.produceOne();
				lastAnchorAt = this.tick();
				// While BOOTSTRAPPING toward genesis with peers, don't mint faster than the mesh gossips a
				// height. Fork choice is heaviest-chain winner-take-all: a farmer that outruns gossip builds a
				// private run that gets orphaned WHOLE, so the losing producers vanish from the canonical chain
				// and the committee never sees its ≥minCommittee distinct producers (the 3-node real-PoST
				// `producers`-collapse). bootstrapPaceMs (≥ gossip latency) caps the bootstrap rate so producers
				// interleave on one chain. Post-genesis the difficulty retarget owns the rate, so this lifts the
				// instant the committee's fund key exists.
				const pace = opts.bootstrapping?.() ? Math.max(opts.busyPaceMs ?? 0, opts.bootstrapPaceMs ?? 0) : (opts.busyPaceMs ?? 0);
				if (pace > 0) await this.sleep(pace);
			} else {
				// Idle: only mine when a heartbeat interval has elapsed.
				const due = this.tick() - lastAnchorAt >= heartbeatMs;
				if (due) {
					await this.produceOne();
					lastAnchorAt = this.tick();
				} else {
					await this.sleep(Math.min(1000, heartbeatMs));
				}
			}
			await new Promise((r) => setImmediate(r));
		}
	}

	private tick(): number {
		return Number(process.hrtime.bigint() / 1_000_000n);
	}
	private sleep(ms: number): Promise<void> {
		return new Promise((r) => setTimeout(r, ms));
	}

	stop(): void {
		this.active = false;
	}
}
