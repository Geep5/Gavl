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
import { WriteStore } from "./store/store.ts";
import { KeepAllPolicy, MinePolicy } from "./store/policy.ts";
import type { PersistPolicy } from "./store/policy.ts";
import { SecretVault } from "./secret/vault.ts";
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
	/** Initial channel/network name (the DHT topic is sha256 of it). Default "gavl". */
	network?: string;
	/** Difficulty schedule. Omit → constant; set → retargets so the VDF cost is the pace. */
	schedule?: RetargetSchedule;
	/** Plot directory for chiapos (default ~/.gavl/plots). */
	plotDir?: string;
	/** Idle heartbeat: when caught up, mine one anchor every this many ms (default 120s). */
	heartbeatMs?: number;
	/** Target seconds-per-anchor — the fallback time estimate when no live cadence is measured (default 60). */
	targetSecPerAnchor?: number;
	/** Durable storage. Omit → in-memory only (RAM, lost on restart). */
	store?: {
		dir?: string; // corestore dir (default ~/.gavl/store)
		/** "all" → archiver (keep everything); "mine" → only my wallet keys + their coins/auctions. */
		persist?: "all" | "mine";
		/** Or supply a custom policy directly (overrides `persist`). */
		policy?: PersistPolicy;
	};
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
	/** Seconds per anchor used for time estimates — measured cadence if live, else the target rate. */
	secPerAnchor: number;
	/** True if secPerAnchor is a live measurement; false if it's the target fallback (cold/idle). */
	secPerAnchorMeasured: boolean;
	/** This node's stable DHT/Noise public key (hex) — its unique address peers dial. Null if mesh off. */
	nodeKey: string | null;
	/** sha256(network) (hex) — the DHT topic every Gavl peer rendezvouses on. Null if mesh off. */
	topic: string | null;
	/** Hex node-keys of currently-connected peers. */
	peerKeys: string[];
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
	private network: string;
	private farming = false;
	private readonly heartbeatMs: number;
	private readonly targetSecPerAnchor: number;
	private store?: WriteStore;
	private readonly storeOpts?: DaemonOptions["store"];
	/** Kept so a channel switch can rebuild ledger/anchors/store identically. */
	private readonly verifier: SpaceVerifier;
	private readonly schedule?: RetargetSchedule;
	/** Whether the last startConsensus joined the mesh / farmed — replayed on switch. */
	private meshOn = false;
	private farmOn = false;
	/** Wall-clock arrival times (ms) of recent tip heights — for a measured anchor cadence.
	 *  Display-only (never touches the deterministic fold), so Date.now() is fine here. */
	private readonly anchorTimes: { height: number; at: number }[] = [];

	constructor(opts: DaemonOptions = {}) {
		this.params = opts.params ?? defaultParams();
		this.k = opts.k ?? 11;
		this.finalityDepth = opts.finalityDepth ?? 1;
		this.heartbeatMs = opts.heartbeatMs ?? 120_000;
		this.targetSecPerAnchor = opts.targetSecPerAnchor ?? 60;
		this.spaceMode = opts.space ?? "standin";
		this.plotDir = opts.plotDir ?? join(homedir(), ".gavl", "plots");
		this.storeOpts = opts.store;
		this.schedule = opts.schedule;
		this.network = opts.network ?? "gavl";
		// Verifier must match the space backend producers use, or anchors are rejected.
		this.verifier = this.spaceMode === "chiapos" ? new ChiaSpaceVerifier() : new StandinSpaceVerifier();
		this.node = new GavlNode(new Ledger(this.params), new AnchorChain(this.params, this.verifier, { schedule: opts.schedule, finalityDepth: this.finalityDepth }));
		this.wallet = new Wallet(opts.walletDir);
		this.wallet.ensureSeeded();
		for (const wa of this.wallet.list()) this.bind(wa);
		this.wireTipCadence();
	}

	/** Record when each new tip height is observed → a rolling measured cadence.
	 *  Re-wired onto the fresh node after a channel switch. */
	private wireTipCadence(): void {
		this.node.onTip = (tip) => {
			const last = this.anchorTimes[this.anchorTimes.length - 1];
			if (!last || tip.height > last.height) {
				this.anchorTimes.push({ height: tip.height, at: Date.now() });
				if (this.anchorTimes.length > 32) this.anchorTimes.shift(); // keep a small window
			}
		};
	}

	/**
	 * Observed seconds-per-anchor over the recent window, or null if we lack data
	 * (cold start) or the network looks idle. "Idle" = the gap since the last
	 * anchor already exceeds the measured average by a wide margin, meaning anchors
	 * have effectively stopped (quiescent heartbeat); the caller falls back to the
	 * difficulty-target rate so the estimate never claims "2 hours" on a network
	 * that won't produce those anchors for days.
	 */
	measuredSecPerAnchor(): number | null {
		const w = this.anchorTimes;
		if (w.length < 3) return null; // not enough samples yet
		const first = w[0];
		const last = w[w.length - 1];
		const spanSec = (last.at - first.at) / 1000;
		const heights = last.height - first.height;
		if (heights <= 0 || spanSec <= 0) return null;
		const avg = spanSec / heights;
		const sinceLast = (Date.now() - last.at) / 1000;
		if (sinceLast > avg * 4 && sinceLast > 30) return null; // looks idle → let caller use target rate
		return avg;
	}

	/**
	 * Open durable storage, replay persisted writes into the ledger (rebuilding
	 * RAM state from disk), then hook persistence so every future accepted write
	 * is offered to the store. Call once, before startConsensus. No-op if storage
	 * is disabled (in-memory only). Replayed writes re-run apply() so the ledger,
	 * anchors, and views are reconstructed exactly.
	 */
	async init(): Promise<{ replayed: number } | null> {
		if (!this.storeOpts) return null;
		// Per-channel store dir: each channel is its own economy (its own anchor chain +
		// listings), so its persisted writes live under channels/<slug>/. The wallet
		// (your identity/keys) is shared across all channels, one level up.
		const base = this.storeOpts.dir ?? join(homedir(), ".gavl", "store");
		const dir = join(base, "channels", channelSlug(this.network ?? "gavl"));
		// "mine" builds a MinePolicy from this node's wallet keys (now that the wallet is ready).
		const policy: PersistPolicy = this.storeOpts.policy ?? (this.storeOpts.persist === "mine" ? new MinePolicy(this.wallet.list().map((a) => a.pubHex)) : new KeepAllPolicy());
		this.store = new WriteStore({ dir, policy });
		await this.store.ready();

		// Replay persisted writes into the ledger BEFORE going live.
		const { writes } = await this.store.replay((w) => {
			this.node.ledger.apply(w);
		});

		// Persist every newly-applied write (write-through, policy-filtered).
		const prev = this.node.onApplied;
		this.node.onApplied = (applied) => {
			prev?.(applied);
			for (const w of applied) void this.store!.persist(w);
		};
		return { replayed: writes };
	}

	storeStats() {
		return this.store?.stats() ?? null;
	}

	private now = (): number => ++this.clock;

	private bind(wa: WalletAccount): Account {
		const vault = new SecretVault({ dir: join(homedir(), ".gavl", "secrets"), pubHex: wa.pubHex, seed: wa.keypair.privateKey });
		const acct = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: wa.keypair, vault });
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

	/** Current "now" on the anchor clock — the finalized anchor's height, or null pre-consensus. */
	finalizedHeight(): number | null {
		return this.node.anchors?.finalized(this.finalityDepth)?.height ?? null;
	}

	consensus(): ConsensusStatus {
		const tip = this.node.anchorTip();
		const finalized = this.node.anchors?.finalized(this.finalityDepth) ?? null;
		const measured = this.measuredSecPerAnchor();
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
			secPerAnchor: measured ?? this.targetSecPerAnchor,
			secPerAnchorMeasured: measured != null,
			nodeKey: this.transport ? this.transport.nodeKeyHex : null,
			topic: this.transport ? this.transport.topicHexValue : null,
			peerKeys: this.transport ? this.transport.connectedPeerKeys() : [],
		};
	}

	/** Join the live mesh and (optionally) start farming anchors. Resilient to a missing network. */
	async startConsensus(opts: { network?: string; mesh: boolean; farm: boolean }): Promise<void> {
		if (opts.network) this.network = opts.network;
		this.meshOn = opts.mesh;
		this.farmOn = opts.farm;

		if (opts.mesh) {
			try {
				this.transport = new SwarmTransport(this.node, {});
				// Don't let a slow/absent DHT block boot — join in the background with a soft cap.
				// Use the resolved channel (this.network), not opts.network — on a channel
				// switch opts.network is omitted and the name lives in this.network.
				const joined = this.transport.join(this.network);
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
			// Adaptive: farm hard while there are unfinalized writes to bury, then drop
			// to a slow heartbeat when idle — work tracks activity instead of running
			// flat-out. busyPaceMs keeps the event loop (HTTP, gossip) responsive.
			void this.producer.runAdaptive({
				until: () => !this.farming,
				finalityDepth: this.finalityDepth,
				busyPaceMs: 250,
				heartbeatMs: this.heartbeatMs,
			});
		}
	}

	/** The channel/network this node is currently on. */
	currentChannel(): string {
		return this.network;
	}

	/**
	 * Leave the current channel and join `name`. A channel is a name-based network:
	 * its own DHT topic (sha256(name)), its own mesh, anchor chain, and economy. We
	 * tear down consensus + the current ledger/store, build a FRESH ledger + anchor
	 * chain for the new channel, rebind accounts (your keys/identity are shared
	 * across channels), replay the new channel's persisted writes, and re-join. No-op
	 * if already on `name`.
	 */
	async switchChannel(name: string): Promise<void> {
		const next = name.trim();
		if (!next || next === this.network) return;

		// 1. Tear down the current channel's consensus + storage.
		this.farming = false;
		this.producer?.stop();
		this.producer = undefined;
		if (this.transport) await this.transport.destroy().catch(() => {});
		this.transport = undefined;
		if (this.store) await this.store.close().catch(() => {});
		this.store = undefined;
		this.anchorTimes.length = 0; // reset cadence samples for the new chain

		// 2. Fresh ledger + anchor chain — a clean economy for the new channel.
		this.node = new GavlNode(new Ledger(this.params), new AnchorChain(this.params, this.verifier, { schedule: this.schedule, finalityDepth: this.finalityDepth }));
		this.wireTipCadence();
		this.accounts.clear();
		for (const wa of this.wallet.list()) this.bind(wa); // same identities, new node

		// 3. Switch to the new channel and bring it up (init store → replay → join + farm).
		this.network = next;
		await this.init();
		await this.startConsensus({ mesh: this.meshOn, farm: this.farmOn });
	}

	async stop(): Promise<void> {
		this.farming = false;
		this.producer?.stop();
		if (this.transport) await this.transport.destroy().catch(() => {});
		if (this.store) await this.store.close().catch(() => {});
	}
}

/** Filesystem-safe slug for a channel name (its store lives under channels/<slug>/). */
function channelSlug(name: string): string {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
	return safe || "default";
}
