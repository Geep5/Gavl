/**
 * Daemon — the local engine behind the web UI.
 *
 * Boots a single Ledger + GavlNode and builds one `Account` per wallet
 * identity, all sharing the node (so they trade with each other locally) and a
 * single monotonic clock (so op timestamps are causally ordered).
 *
 * With consensus wired (the default), the node also carries an AnchorChain, the
 * daemon joins the live hyperswarm/hyperdht mesh (gossiping writes AND anchors),
 * and runs a Producer that farms anchors over the heaviest tip. The UI can then
 * watch the real consensus advance: tip height/weight climbing, finality
 * deepening, settled auctions becoming final.
 *
 * VDF is real chiavdf by default (genuine cooldown). The anchor space proof uses
 * the light stand-in by default so the node boots instantly without plotting —
 * the consensus mechanics (fork choice, finality, weight, gossip) are identical
 * either way; chiapos is opt-in via GAVL_SPACE=chiapos.
 */

import { Ledger } from "./ledger/ledger.ts";
import { GavlNode } from "./sync/node.ts";
import { Account } from "./auction/account.ts";
import { computeView } from "./auction/state.ts";
import type { View } from "./auction/state.ts";
import { Wallet } from "./wallet.ts";
import type { WalletAccount } from "./wallet.ts";
import { defaultParams } from "./config.ts";
import type { ChainParams } from "./chain/writer.ts";
import { AnchorChain } from "./consensus/chain.ts";
import type { RetargetSchedule } from "./consensus/difficulty.ts";
import { Producer } from "./consensus/producer.ts";
import { StandinSpaceProver, StandinSpaceVerifier } from "./consensus/space.ts";
import type { SpaceVerifier, SpaceProver } from "./consensus/space.ts";
import { ChiaSpaceProver, ChiaSpaceVerifier, ensurePlot } from "./pos/chia.ts";
import { finalizedView } from "./consensus/order.ts";
import { Plot } from "./pos/space.ts";
import { SwarmTransport } from "./sync/swarm.ts";
import { generateKeyPair } from "./det/ed25519.ts";
import { toHex } from "./det/canonical.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpaceMode = "standin" | "chiapos";

export interface DaemonOptions {
	walletDir?: string;
	params?: ChainParams;
	/** Plot-size exponent for each identity's PoST plot. */
	k?: number;
	/** Anchor-depth at which state is considered final. */
	finalityDepth?: number;
	/** Anchor space backend: light stand-in (default) or real chiapos (real disk cost). */
	space?: SpaceMode;
	/** Difficulty schedule. Omit → constant; set → retargets so the VDF cost is the pace. */
	schedule?: RetargetSchedule;
	/** Plot directory for chiapos (default ~/.gavl/plots). */
	plotDir?: string;
}

export interface ConsensusStatus {
	enabled: boolean;
	vdf: string;
	space: string;
	mesh: boolean;
	network: string | null;
	peers: number;
	farming: boolean;
	tip: { height: number; weight: string; id: string } | null;
	finalizedHeight: number | null;
}

export class Daemon {
	readonly node: GavlNode;
	readonly wallet: Wallet;
	readonly finalityDepth: number;
	private readonly params: ChainParams;
	private readonly k: number;
	private readonly spaceMode: SpaceMode;
	private readonly plotDir: string;
	private readonly accounts = new Map<string, Account>();
	private clock = 0;

	private transport?: SwarmTransport;
	private producer?: Producer;
	private network: string | null = null;
	private farming = false;

	constructor(opts: DaemonOptions = {}) {
		this.params = opts.params ?? defaultParams();
		this.k = opts.k ?? 11;
		this.finalityDepth = opts.finalityDepth ?? 1;
		this.spaceMode = opts.space ?? "standin";
		this.plotDir = opts.plotDir ?? join(homedir(), ".gavl", "plots");
		// Verifier must match the space backend producers use, or anchors are rejected.
		const verifier: SpaceVerifier = this.spaceMode === "chiapos" ? new ChiaSpaceVerifier() : new StandinSpaceVerifier();
		this.node = new GavlNode(new Ledger(this.params), new AnchorChain(this.params, verifier, { schedule: opts.schedule, finalityDepth: this.finalityDepth }));
		this.wallet = new Wallet(opts.walletDir);
		this.wallet.ensureSeeded();
		for (const wa of this.wallet.list()) this.bind(wa);
	}

	private now = (): number => ++this.clock;

	private bind(wa: WalletAccount): Account {
		const acct = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: wa.keypair });
		this.accounts.set(wa.pubHex, acct);
		return acct;
	}

	account(pubHex: string): Account {
		const existing = this.accounts.get(pubHex);
		if (existing) return existing;
		const wa = this.wallet.get(pubHex);
		if (!wa) throw new Error(`daemon: unknown account ${pubHex}`);
		return this.bind(wa);
	}

	active(): Account {
		return this.account(this.wallet.active().pubHex);
	}

	createAccount(label: string): Account {
		return this.bind(this.wallet.create(label));
	}

	/** Optimistic view over all local writes (responsive — reflects an action immediately). */
	view(): View {
		return computeView(this.node.ledger.allWrites());
	}

	/** Finality-bound view: only state the anchor chain has certified `finalityDepth` deep. */
	finalView(): View {
		if (!this.node.anchors) return computeView([]);
		return finalizedView(this.node.ledger.allWrites(), this.node.anchors, this.finalityDepth);
	}

	consensus(): ConsensusStatus {
		const tip = this.node.anchorTip();
		const finalized = this.node.anchors?.finalized(this.finalityDepth) ?? null;
		return {
			enabled: !!this.node.anchors,
			vdf: this.params.vdf.name,
			space: this.spaceMode,
			mesh: !!this.transport,
			network: this.network,
			peers: this.node.peerCount,
			farming: this.farming,
			tip: tip ? { height: tip.height, weight: tip.weight, id: tip.id } : null,
			finalizedHeight: finalized ? finalized.height : null,
		};
	}

	/** Join the live mesh and (optionally) start farming anchors. Resilient to a missing network. */
	async startConsensus(opts: { network: string; mesh: boolean; farm: boolean }): Promise<void> {
		this.network = opts.network;

		if (opts.mesh) {
			try {
				this.transport = new SwarmTransport(this.node, {});
				// Don't let a slow/absent DHT block boot — join in the background with a soft cap.
				const joined = this.transport.join(opts.network);
				await Promise.race([joined, new Promise((r) => setTimeout(r, 8000))]);
			} catch (e) {
				console.warn(`[daemon] mesh join failed (continuing local): ${(e as Error).message}`);
				this.transport = undefined;
			}
		}

		if (opts.farm) {
			const farmer = generateKeyPair();
			let prover: SpaceProver;
			if (this.spaceMode === "chiapos") {
				// Real disk cost: plot the farmer's chiapos plot (slow the first time, then cached).
				const pub = toHex(farmer.publicKey);
				const plotPath = ensurePlot(pub, this.k, this.plotDir);
				prover = new ChiaSpaceProver({ pubHex: pub, k: this.k, plotPath });
			} else {
				prover = new StandinSpaceProver(new Plot(farmer.publicKey, this.k));
			}
			this.producer = new Producer({ node: this.node, keypair: farmer, prover, params: this.params });
			this.farming = true;
			// Fire-and-forget farming loop; paced so the event loop (HTTP, gossip) stays responsive.
			// With a difficulty schedule the VDF cost is the real pace; paceMs is just a yield.
			void this.producer.run({ until: () => !this.farming, paceMs: 1500 });
		}
	}

	async stop(): Promise<void> {
		this.farming = false;
		this.producer?.stop();
		if (this.transport) await this.transport.destroy().catch(() => {});
	}
}
