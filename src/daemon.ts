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

import { Ledger, rootOfHeads } from "./ledger/ledger.ts";
import { GavlNode } from "./sync/node.ts";
import { Account } from "./market/account.ts";
import { computeView, finalizedView, viewAtAnchor, mark, gbtcOf } from "./market/btc.ts";
import type { View, MarketDef } from "./market/btc.ts";
import { serializeView, deserializeView, viewRoot } from "./market/state.ts";
import type { Anchor } from "./consensus/anchor.ts";
import type { Heads } from "./ledger/ledger.ts";
import { longPayout, verifyOffer } from "./market/intent.ts";
import type { Offer, Side } from "./market/intent.ts";
import type { FundKey } from "./custody/threshold.ts";
import { DkgCoordinator } from "./custody/dkg-coordinator.ts";
import { saveShare, loadShare } from "./custody/share-store.ts";
import type { StoredShare } from "./custody/share-store.ts";
import { fundAddress as deriveFundAddress } from "./custody/bitcoin.ts";
import { depositAddress } from "./custody/deposit.ts";
import { buildWithdrawalTx } from "./custody/btctx.ts";
import { signWithdrawalWithFailover } from "./custody/withdraw-ceremony.ts";
import { SignCoordinator } from "./custody/sign-coordinator.ts";
import { CommitteeRotation } from "./custody/rotation.ts";
import { EquivocationWatcher } from "./custody/equivocation-watcher.ts";
import { makeCeremonyAuth } from "./custody/ceremony-auth.ts";
import type { CeremonyAuth } from "./custody/ceremony-auth.ts";
import { committeeEpochsFor, epochOf } from "./custody/epoch.ts";
import type { AnchorView } from "./custody/epoch.ts";
import { committeeTopic, quorumForRound } from "./custody/committee.ts";
import { depositAttestationDigest, settleAttestationDigest } from "./custody/attestation.ts";
import { isCeremonyTimeout } from "./custody/ceremony.ts";
import { Esplora } from "./custody/esplora.ts";
import { checkDeposit, utxosToInputs, confirmations, MIN_CONFIRMATIONS } from "./custody/watcher.ts";
import { pendingClaims, unsentWithdrawals, inFlightWithdrawals, slashable } from "./custody/bridge.ts";
import { fetchPythUpdate, fetchSignedUpdate, HERMES_URL } from "./market/pricefeed.ts";
import { verifyPythUpdate } from "./market/pyth.ts";
import { verifySignedQuorum } from "./market/signed-feed.ts";
import type { AggregateReading } from "./market/pricefeed.ts";
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
import { Plot } from "./pos/space.ts";
import { SwarmTransport, swarmKeyPair } from "./sync/swarm.ts";
import { KnownPeers } from "./sync/known-peers.ts";
import { BootstrapList } from "./sync/bootstrap.ts";
import { generateKeyPair, keyPairFromSeed } from "./det/ed25519.ts";
import type { KeyPair } from "./det/ed25519.ts";
import { toHex, fromHex, sha256 } from "./det/canonical.ts";
import { WriteStore } from "./store/store.ts";
import type { StoredSnapshot } from "./store/store.ts";
import { KeepAllPolicy, MinePolicy } from "./store/policy.ts";
import type { PersistPolicy } from "./store/policy.ts";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

export type SpaceMode = "standin" | "chiapos";

export interface DaemonOptions {
	walletDir?: string;
	params?: ChainParams;
	/** Plot-size exponent for each identity's PoST plot. */
	k?: number;
	/** Anchor-depth at which state is considered final. */
	finalityDepth?: number;
	/** Distinct peers that must offer the same checkpoint before a fresh node adopts it as a trusted
	 *  floor (genesis-free bootstrap). Default 1 (trust the first peer); set ≥2 for quorum so a lone
	 *  or sybil peer can't feed a fabricated history. See docs/weak-subjectivity.md. */
	adoptQuorum?: number;
	/** Anchor space backend: light stand-in (default) or real chiapos (real disk cost). */
	space?: SpaceMode;
	/** Initial channel/network name (the DHT topic is sha256 of it). Default "gavl". */
	network?: string;
	/** GAVL_BOOTSTRAP value (comma-separated host:port) — custom DHT entry nodes, added to defaults. */
	bootstrapEnv?: string;
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
	/**
	 * Threshold-custody config. There is ONLY one mode: an autonomous epoch-driven committee. The
	 * fund key is DKG'd across a PoST-weighted committee sampled from the anchor chain and reshared
	 * to a fresh committee each epoch, no node ever holding it whole. Needs farming on (the node's
	 * stable producer key is its committee id). A lone node (< minCommittee farmers) holds NO key and
	 * cannot mint — it waits for peers. There is no single-key/solo fallback, on any network.
	 */
	custody?: {
		/** Anchors per custody epoch (default 16). */
		epochLength?: number;
		/** Target committee size, clamped to eligible producers (default 5). */
		size?: number;
		/** Genesis committee size — small so the n-of-n DKG completes; grown to `size` by the first
		 *  reshare (default: minCommittee). */
		genesisSize?: number;
		/** Min eligible producers before committee custody activates (default 3). */
		minCommittee?: number;
		/** Per-ceremony timeout in ms (default 30s). */
		ceremonyTimeoutMs?: number;
		/** Membership lookback in anchors (default: all). */
		windowAnchors?: number;
		/** Gate #3: stake-weight committee selection by bonded gBTC (only bonded producers
		 *  are eligible). Off → weight by anchors produced (the pre-bonding model). */
		bonded?: boolean;
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
	/** Hex node-keys pinned for re-dial on every boot (eclipse resistance). */
	pinnedPeers: string[];
	/** The full effective DHT bootstrap list ("host:port"), each flagged if it's a built-in default. */
	bootstrap: { node: string; default: boolean }[];
}

/**
 * Source-side oracle pruning: should this node mint a new on-chain price post?
 *
 * Posting an identical price every poll is dead-weight — it grows every node's
 * write-chain and durable store forever, and (deleting it after the fact is a
 * consensus-level change to the hash-chained ledger, so we avoid creating it).
 * We post only when the price actually MOVED ≥ `minMoveBps` from the last post,
 * or it's gone STALE (≥ `heartbeatMs` since the last post) so the mark never
 * drifts too old. `lastPrice == null` (never posted) always posts.
 *
 * Pure + exported so the gating is unit-testable without the network/clock.
 */
export function oracleShouldPost(a: { v: bigint; lastPrice: bigint | null; lastPostAt: number; now: number; minMoveBps: number; heartbeatMs: number }): boolean {
	if (a.lastPrice == null || a.lastPrice === 0n) return true; // first post for this writer
	const diff = a.v > a.lastPrice ? a.v - a.lastPrice : a.lastPrice - a.v;
	const movedBps = Number((diff * 10_000n) / a.lastPrice);
	if (movedBps >= a.minMoveBps) return true; // moved enough to be worth a write
	return a.now - a.lastPostAt >= a.heartbeatMs; // else only on the staleness heartbeat
}

/** How many finalized anchors between durable checkpoints. Small enough to bound growth,
 *  large enough that snapshotting/pruning isn't a per-anchor cost. Override for tests/tuning. */
const CHECKPOINT_EVERY = Number(process.env.GAVL_CHECKPOINT_EVERY ?? "16");

/** Default offer lifetime in anchors. Long enough to rest and get filled on a quiet market,
 *  finite so its consensus fill-tracking (offerFills) retires after expiry instead of forever. */
const OFFER_TTL_ANCHORS = Number(process.env.GAVL_OFFER_TTL ?? "2880");

/** Anchors retained below a checkpoint. Generous enough to cover the retarget + committee
 *  windows (the only backward walks that reach below the checkpoint); the daemon takes the
 *  max with those windows. Bounds the anchor chain to a constant suffix instead of forever. */
const ANCHOR_KEEP_MARGIN = Number(process.env.GAVL_ANCHOR_MARGIN ?? "256");

export class Daemon {
	readonly node: GavlNode;
	readonly wallet: Wallet;
	readonly knownPeers = new KnownPeers();
	readonly bootstrap: BootstrapList;
	readonly finalityDepth: number;
	private readonly adoptQuorum: number;
	private readonly params: ChainParams;
	private readonly k: number;
	private readonly spaceMode: SpaceMode;
	private readonly plotDir: string;
	/** Root for node-local custody secrets (share + producer key), beside the wallet —
	 *  so a distinct walletDir fully isolates a node (multiple nodes on one machine). */
	private readonly dataDir: string;
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
	private readonly custodyOpts: NonNullable<DaemonOptions["custody"]>;
	private producerKeyCache?: KeyPair;
	private custodyAcct?: Account;
	private rotation?: CommitteeRotation;
	private equivWatcher?: EquivocationWatcher;
	/** Kept so a channel switch can rebuild ledger/anchors/store identically. */
	private readonly verifier: SpaceVerifier;
	private readonly schedule?: RetargetSchedule;
	/** Whether the last startConsensus joined the mesh / farmed — replayed on switch. */
	private meshOn = false;
	private farmOn = false;
	private publishing = false;
	/** The oracle-publish config, remembered so it re-starts on a fresh chain after a
	 *  channel switch (otherwise the new channel has no oracle → no price loads). */
	private oraclePublishOpts?: { everyMs: number };
	/** Bumped each time a publisher loop (re)starts, so an old loop bound to a torn-down
	 *  node exits cleanly on a channel switch. */
	private oracleGen = 0;
	private lastOracleSource: (AggregateReading & { at: number }) | null = null;
	/** Wall-clock arrival times (ms) of recent tip heights — for a measured anchor cadence.
	 *  Display-only (never touches the deterministic fold), so Date.now() is fine here. */
	private readonly anchorTimes: { height: number; at: number }[] = [];

	constructor(opts: DaemonOptions = {}) {
		this.params = opts.params ?? defaultParams();
		this.k = opts.k ?? 11;
		this.finalityDepth = opts.finalityDepth ?? 1;
		this.adoptQuorum = opts.adoptQuorum ?? 1;
		this.heartbeatMs = opts.heartbeatMs ?? 120_000;
		this.targetSecPerAnchor = opts.targetSecPerAnchor ?? 60;
		this.spaceMode = opts.space ?? "standin";
		this.plotDir = opts.plotDir ?? join(homedir(), ".gavl", "plots");
		this.dataDir = opts.walletDir ?? join(homedir(), ".gavl");
		this.storeOpts = opts.store;
		this.custodyOpts = opts.custody ?? {};
		this.schedule = opts.schedule;
		this.network = opts.network ?? "gavl";
		this.bootstrap = new BootstrapList(undefined, opts.bootstrapEnv);
		// Verifier must match the space backend producers use, or anchors are rejected.
		this.verifier = this.spaceMode === "chiapos" ? new ChiaSpaceVerifier() : new StandinSpaceVerifier();
		this.node = new GavlNode(new Ledger(this.params), new AnchorChain(this.params, this.verifier, { schedule: opts.schedule, finalityDepth: this.finalityDepth, verifyState: (a, h) => this.checkAppRoot(a, h) }));
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
			this.driveRotation(); // advance the custody epoch loop on each finality move
			this.maintainCommitteeTopics(); // keep this node joined to its committee's sub-swarm
			this.maybeAuthorizePending(); // co-sign pending withdrawals / mints / settles
			this.maybeCheckpoint(); // snapshot + prune behind finality so history never grows unbounded
			this.tryPendingSnapshot(); // a stashed peer checkpoint may now be verifiable
		};
		// matched-market intent gossip — (re)wire onto the fresh node.
		this.node.onIntent = (offer) => this.receiveIntent(offer);
		this.node.intentsToShare = () => [...this.offers.values()];
		// checkpoint bootstrap — let a fresh peer load our latest state instead of all history.
		this.node.snapshotHeader = () => (this.lastSnapshot ? { anchorId: this.lastSnapshot.anchorId, height: this.lastSnapshot.height } : null);
		this.node.fullSnapshot = () => this.lastSnapshot ?? null;
		this.node.wantSnapshot = (offer) => this.node.ledger.summary().writers === 0 && offer.height > this.lastCheckpointHeight; // only a truly fresh node bootstraps from state
		this.node.onSnapshot = (snap) => this.ingestSnapshot(snap);
		this.node.adoptFloor = (candidates) => this.adoptFloor(candidates);
		this.node.snapshotQuorum = this.adoptQuorum; // distinct peers required to adopt a checkpoint
	}

	/** Verify a peer-supplied checkpoint against our synced anchor chain, then seed from it.
	 *  Trust comes from the anchor chain: the checkpoint's heads must match the finalized
	 *  anchor's stateRoot, and its committed state must match that anchor's CHILD appRoot
	 *  (appRoot is lag-by-parent). If the anchors aren't synced yet, stash + retry on next tip. */
	private ingestSnapshot(snap: StoredSnapshot): boolean {
		const anchors = this.node.anchors;
		if (!anchors) return false;
		const anchor = anchors.get(snap.anchorId);
		if (!anchor) {
			this.pendingSnapshot = snap; // anchors not here yet → retry once they sync
			return false;
		}
		if (rootOfHeads(snap.heads) !== anchor.stateRoot) return false; // heads not the ones this anchor PoST-committed
		const child = anchors.chainTo().find((a) => a.prev === snap.anchorId); // the anchor that commits snap's state (lag-by-parent)
		if (!child) {
			this.pendingSnapshot = snap; // need the child anchor to authenticate the state
			return false;
		}
		if (viewRoot(deserializeView(snap.state)) !== child.appRoot) return false; // state doesn't match the committed appRoot → reject
		// Authentic. Seed the ledger at the checkpoint + rebase folds onto its state.
		this.node.ledger.seedCheckpoint(snap.heads);
		this.checkpointBase = deserializeView(snap.state);
		this.lastCheckpointHeight = snap.height;
		this.lastSnapshot = snap;
		this.pendingSnapshot = undefined;
		this.viewCache = undefined;
		this.finalCache = undefined;
		return true;
	}

	/** Genesis-free bootstrap (node.adoptFloor hook): a truly fresh node can't link a pruned anchor
	 *  suffix back to genesis. If we've pulled a checkpoint, adopt ITS anchor (found among the suffix)
	 *  as a TRUSTED floor — weak subjectivity: we trust the checkpoint we chose to bootstrap from; its
	 *  PoST isn't re-verified to genesis (grindable/unprovable), but everything above it is, and the
	 *  STATE is authenticated separately (ingestSnapshot checks the child anchor's appRoot). Returns
	 *  true if a floor was installed (then the suffix links above it and onTip seeds the state). */
	private adoptFloor(candidates: Anchor[]): boolean {
		const anchors = this.node.anchors;
		const snap = this.pendingSnapshot;
		if (!anchors || !snap || anchors.tip() !== null) return false; // only on a fresh chain, with a pulled checkpoint
		const floor = candidates.find((a) => a.id === snap.anchorId);
		if (!floor) return false; // the checkpoint's anchor isn't in this suffix (yet)
		if (!this.node.snapshotQuorumMet(snap.anchorId)) return false; // not enough distinct peers vouch for this floor
		if (rootOfHeads(snap.heads) !== floor.stateRoot) return false; // snapshot heads must be the ones the floor PoST-committed
		try {
			anchors.adopt(floor, snap.heads); // install the trusted root (throws if unsafe — e.g. off an epoch boundary)
		} catch {
			return false;
		}
		return true; // ingestSnapshot (on the next tip) authenticates + seeds the state above this floor
	}

	/** Retry a stashed snapshot once the anchor chain has caught up (called on each tip move).
	 *  On success, re-advertise so peers serve the post-checkpoint write tail. */
	private tryPendingSnapshot(): void {
		if (this.pendingSnapshot && this.ingestSnapshot(this.pendingSnapshot)) this.node.advertise();
	}

	/** Feed the finalized chain to the custody rotation loop (no-op unless committee
	 *  mode is active). Non-reentrant + one-shot per epoch, so calling on every tip is cheap. */
	private driveRotation(): void {
		const rot = this.rotation;
		const anchors = this.node.anchors;
		if (!rot || !anchors) return;
		const finalAnchor = anchors.finalized(this.finalityDepth);
		if (!finalAnchor) return;
		void rot.onFinalized(anchors.chainTo(finalAnchor) as AnchorView[]);
	}

	/**
	 * Join the committee sub-swarm topic(s) this node belongs to (and leave the rest),
	 * so the small committee forms a DIRECT sub-mesh for the ceremonies independent of
	 * the sparse 100+-node main mesh. Computed over the optimistic chain for the current
	 * + just-finalized epochs, so a node pre-connects BEFORE its ceremony fires. This is
	 * connectivity only — ceremony membership stays finalized-deterministic. No-op unless
	 * committee mode + a live transport.
	 */
	private maintainCommitteeTopics(): void {
		if (!this.transport) return;
		const anchors = this.node.anchors;
		const tip = anchors?.tip();
		if (!anchors || !tip) return;
		const chain = anchors.chainTo(tip) as AnchorView[];
		const epochLength = this.custodyOpts.epochLength ?? 16;
		const finEpoch = epochOf(anchors.finalized(this.finalityDepth)?.height ?? 0, epochLength);
		const optEpoch = epochOf(tip.height, epochLength);
		const mine = committeeEpochsFor(chain, this.producerId(), [finEpoch, optEpoch], {
			epochLength,
			size: this.custodyOpts.size ?? 5,
			minCommittee: this.custodyOpts.minCommittee ?? 3,
			windowAnchors: this.custodyOpts.windowAnchors,
			bonds: this.custodyOpts.bonded ? this.finalView().bridge.bonds : undefined,
		});
		void this.transport.setCommitteeTopics(mine.map((e) => committeeTopic(this.network, e)));
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

		// Boot from the last durable checkpoint instead of replaying from 0: load the committed
		// state, seed the ledger at the checkpoint heads, and rebase future folds onto it. Writes
		// at/below the floor then no-op in apply() (a cheap seq compare — no fold), so replay only
		// re-applies the post-checkpoint tail. Self-trusted (we computed it); a peer-supplied
		// snapshot is appRoot-verified on the sync path.
		const snap = await this.store.loadSnapshot();
		if (snap) {
			this.checkpointBase = deserializeView(snap.state);
			this.node.ledger.seedCheckpoint(snap.heads);
			this.lastCheckpointHeight = snap.height;
			this.lastSnapshot = snap; // serve it to fresh peers too
			console.log(`  storage: loaded checkpoint at height ${snap.height} (${Object.keys(snap.heads).length} writer head(s)) — skipping replay below it`);
		}

		// Replay persisted writes into the ledger BEFORE going live. Seed the logical
		// clock past the highest replayed ts so new writes are GLOBALLY monotonic —
		// otherwise a restart resets ts to 0, colliding with persisted writes and
		// scrambling the optimistic (ts-ordered) fold.
		const { writes } = await this.store.replay((w) => {
			// skipTimeProof: these writes already passed full verification (VDF included) before they
			// were persisted, so re-walking each O(iters) cooldown here would block boot for minutes on
			// a large backlog. The cheap sig/id/structure checks still run, catching disk corruption.
			this.node.ledger.apply(w, { skipTimeProof: true });
			if (w.ts > this.clock) this.clock = w.ts;
		});

		// Persist every newly-applied write (write-through, policy-filtered). Guarded against
		// a store that's being torn down mid-flight (a channel switch closes it) — a late
		// write must NOT crash the daemon with an unhandled "Corestore is closed" rejection.
		const prev = this.node.onApplied;
		this.node.onApplied = (applied) => {
			prev?.(applied);
			const store = this.store;
			if (!store) return;
			for (const w of applied) void store.persist(w).catch(() => {});
		};
		return { replayed: writes };
	}

	storeStats() {
		return this.store?.stats() ?? null;
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

	/** Optimistic view over all local writes (responsive — reflects an action immediately).
	 *  Folds the writes the ledger still holds onto the checkpoint base (so it never re-folds
	 *  pruned history), and memoizes on the heads root so polls don't re-fold unchanged state. */
	view(): View {
		const root = this.node.ledger.stateRoot();
		if (this.viewCache && this.viewCache.root === root) return this.viewCache.view;
		const view = computeView(this.node.ledger.allWrites(), { base: this.checkpointBase, market: this.channelMarket() });
		this.viewCache = { root, view };
		return view;
	}

	/** This channel's market definition (`label::pyth::feedId` / `label::signed::setHash`), or
	 *  undefined for a plain (non-market) channel. A per-channel constant every node agrees on →
	 *  deterministic fold. The fold accepts a quorum-SIGNED update from anyone, verified against this def. */
	channelMarket(): MarketDef | undefined {
		const c = parseChannel(this.network);
		if (!c) return undefined;
		return c.kind === "pyth" ? { kind: "pyth", feedId: c.feedId } : { kind: "signed", signerSet: c.signerSet };
	}

	/** Fetch-test a Pyth feed before creating a `label::pyth::feedId` market: pull the latest Hermes
	 *  update and VERIFY it (guardian quorum + Merkle), returning the attested price/expo or an error. */
	async testPythFeed(feedId: string): Promise<{ value: string | null; expo: number | null; error?: string }> {
		const id = feedId.toLowerCase().replace(/^0x/, "");
		if (!/^[0-9a-f]{64}$/.test(id)) return { value: null, expo: null, error: "a Pyth feed id is 64 hex characters" };
		const blob = await fetchPythUpdate(id);
		if (!blob) return { value: null, expo: null, error: "couldn't fetch a Pyth update for that feed" };
		const p = verifyPythUpdate(blob).find((x) => x.feedId === id);
		if (!p) return { value: null, expo: null, error: "no verified price for that feed id" };
		return { value: p.price.toString(), expo: p.expo };
	}

	// ── state-committed checkpoints — the ledger never replays from 0 ──────
	/** View at the ledger's prune floor (the last checkpoint). The ledger holds only writes
	 *  ABOVE it; every fold resumes from here. Undefined ⇒ full history (never checkpointed). */
	private checkpointBase?: View;
	private lastCheckpointHeight = -1;
	/** The latest durable checkpoint (kept in memory so it can be served to fresh peers). */
	private lastSnapshot?: StoredSnapshot;
	/** A peer's checkpoint awaiting anchor-chain sync before it can be authenticated. */
	private pendingSnapshot?: StoredSnapshot;
	private viewCache?: { root: string; view: View };
	private finalCache?: { id: string | null; view: View };
	private emptyAppRootCache?: string;

	private emptyAppRoot(): string {
		return (this.emptyAppRootCache ??= viewRoot(computeView([])));
	}

	/** The appRoot an anchor extending `prev` must commit: viewRoot of the state `prev`
	 *  certified (empty at genesis). Lag-by-parent → always computable from an in-chain anchor.
	 *  Resumes from the checkpoint base so a pruned node folds forward, not from genesis. */
	private appRootForParent(prev: Anchor | null): string {
		if (!prev || !this.node.anchors) return this.emptyAppRoot();
		return this.appRootFor(prev.id);
	}

	/** Memoized appRoot for the state `prevId` certified. It's a pure function of `prevId`
	 *  (lag-by-parent → all children of prev commit the same appRoot) and the checkpoint base —
	 *  prev's certified writes are immutable once in-chain. So cache by prevId, scoped to the
	 *  checkpoint epoch (lastCheckpointHeight): when the base advances the whole cache is dropped
	 *  (the old, now-pruned prevIds go with it). Folded once per (prev, checkpoint) instead of on
	 *  every mine + every inbound anchor's verifyState. */
	private appRootCache = new Map<string, string>();
	private appRootCacheEpoch = Number.NaN;
	private appRootFor(prevId: string): string {
		if (this.appRootCacheEpoch !== this.lastCheckpointHeight) {
			this.appRootCache.clear();
			this.appRootCacheEpoch = this.lastCheckpointHeight;
		}
		let r = this.appRootCache.get(prevId);
		if (r === undefined) {
			r = viewRoot(viewAtAnchor(this.node.ledger.allWrites(), this.node.anchors!, prevId, this.checkpointBase, this.channelMarket()));
			this.appRootCache.set(prevId, r);
		}
		return r;
	}

	/** AnchorChain.verifyState hook — enforce a peer's appRoot against our own fold. If we lack
	 *  the parent's certified writes we DEFER (can't judge yet; re-checked when they arrive). */
	private checkAppRoot(anchor: Anchor, _heads: Heads): boolean {
		const anchors = this.node.anchors;
		if (!anchors) return true;
		const prev = anchor.prev ? anchors.get(anchor.prev) ?? null : null;
		if (!prev) return anchor.appRoot === this.emptyAppRoot();
		const prevHeads = anchors.headsAt(prev.id);
		if (!this.haveAllWrites(prevHeads)) return true; // missing data → defer, don't reject
		return anchor.appRoot === this.appRootFor(prev.id);
	}

	/** True if our ledger holds every writer's chain up to `heads` (so we can fold that state). */
	private haveAllWrites(heads: Heads): boolean {
		for (const writer of Object.keys(heads)) {
			if (this.node.ledger.idAt(writer, heads[writer].seq) !== heads[writer].id) return false;
		}
		return true;
	}

	/** Once finality advances past the cadence, checkpoint the committed state and prune history
	 *  behind it so RAM never grows without bound — for EVERY node, with or without a durable
	 *  store. The checkpoint is a RAM-first thing: a key-only client (no store, just its key on
	 *  disk) bounds its own memory and can serve the checkpoint to fresh peers exactly like an
	 *  archiver. A durable store, if present, additionally persists the snapshot + reclaims disk
	 *  so the node can also resume from its own disk after a crash. Idempotent + cheap per tip. */
	private maybeCheckpoint(): void {
		const anchors = this.node.anchors;
		if (!anchors) return;
		const fin = anchors.finalized(this.finalityDepth);
		if (!fin) return;
		// Checkpoint at a DETERMINISTIC height — the largest CHECKPOINT_EVERY boundary the finalized
		// anchor has crossed — not at each node's current finalized tip. So every honest node
		// checkpoints the SAME anchor, and a bootstrapping node can collect a quorum of identical
		// offers (see docs/weak-subjectivity.md). Local-only; checkpoints aren't committed in any root.
		const target = Math.floor(fin.height / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
		if (target <= 0 || target <= this.lastCheckpointHeight) return;
		let ckpt: Anchor | undefined = fin;
		while (ckpt && ckpt.height > target) ckpt = ckpt.prev ? anchors.get(ckpt.prev) : undefined;
		if (!ckpt || ckpt.height !== target) return; // the boundary anchor isn't reachable yet → wait
		const heads = anchors.headsAt(ckpt.id);
		if (Object.keys(heads).length === 0) return; // nothing certified yet
		const view = viewAtAnchor(this.node.ledger.allWrites(), anchors, ckpt.id, this.checkpointBase, this.channelMarket()); // state at the boundary
		this.lastCheckpointHeight = ckpt.height;
		this.checkpointBase = view;
		const snap: StoredSnapshot = { anchorId: ckpt.id, height: ckpt.height, heads, state: serializeView(view) };
		this.lastSnapshot = snap; // kept in RAM to serve fresh peers (key-only nodes included)
		const before = this.node.ledger.summary().writes;
		this.node.ledger.pruneBelow(heads); // drop RAM history below the checkpoint — bounds memory
		// Bound the anchor chain too (local memory only — not committed in any root). Keep a
		// suffix below the checkpoint that still covers the retarget + committee windows, so
		// every backward walk (difficulty, finality, committee selection, heads) stays intact.
		const anchorsBefore = anchors.size;
		const margin = Math.max(ANCHOR_KEEP_MARGIN, this.schedule?.window ?? 0, this.custodyOpts.windowAnchors ?? 0);
		anchors.prune(ckpt.height - margin); // keep a margin below the CHECKPOINT (not the tip) so it stays serveable
		this.viewCache = undefined;
		this.finalCache = undefined;
		// Durable store, if any: persist the snapshot + reclaim the pruned blocks (best-effort).
		const store = this.store;
		const persisted = store ? " (persisting)" : " (RAM-only)";
		if (store) void store.persistSnapshot(snap).then(() => store.pruneBelow(heads)).catch(() => {});
		console.log(`  checkpoint: height ${ckpt.height} (boundary), ${Object.keys(heads).length} writer(s); pruned ${before - this.node.ledger.summary().writes} write(s) + ${anchorsBefore - anchors.size} anchor(s) from RAM${persisted}`);
	}

	// ── peer-to-peer intent market (in-memory offer book) ────────────
	// Non-binding signed offers rest here locally (the gossip layer will replicate them
	// across nodes later). Broadcasting signs an offer with the active account; taking one
	// authors a match.open write that escrows BOTH peers and opens a matched contract.
	private offers = new Map<string, Offer>(); // nonce → signed offer

	/** Broadcast a non-binding intent from the active account → local book + the mesh. */
	broadcastIntent(side: Side, size: string, leverage: string): Offer {
		const me = this.active();
		// Globally-unique nonce (crypto-random) so it never collides with a previously-matched
		// offer's nonce in the persisted offerFills — even across restarts / store resets.
		const nonce = `${me.pubHex.slice(0, 8)}-${randomBytes(8).toString("hex")}`;
		// Finite TTL (anchors) so the offer's fill-tracking can be retired after it expires —
		// otherwise offerFills (consensus state) grows with every offer ever broadcast.
		const expiryHeight = (this.node.anchorTip()?.height ?? 0) + OFFER_TTL_ANCHORS;
		const offer = me.makeOffer({ makerSide: side, size, leverage, expiryHeight, nonce });
		if (!this.canBack(offer)) throw new Error("insufficient gBTC to back this offer"); // peers would drop it anyway
		this.offers.set(nonce, offer);
		this.node.gossipIntent(offer); // flood it to peers so their tapes show it
		return offer;
	}

	/** Can `offer`'s maker actually back it? — total resting offer notional from that maker must
	 *  be covered by their current free gBTC. This is the match-time ghost-check (we verify it at
	 *  match anyway), applied at gossip time: unfunded spam is dropped on arrival for free, and
	 *  every offer the tape keeps is tied to real gBTC (PoST/BTC-bounded capital) — so the tape
	 *  self-bounds to the funded economy, no cap needed. */
	private canBack(offer: Offer, view = this.view()): boolean {
		const free = gbtcOf(view, offer.maker);
		if (free <= 0n) return false; // unfunded → can't cover any stake; the match would ghost-fail
		const fills = view.book.offerFills;
		let resting = BigInt(offer.size) - (fills.get(offer.nonce)?.filled ?? 0n);
		if (resting <= 0n) return false; // nothing left to rest
		for (const o of this.offers.values()) {
			if (o.maker !== offer.maker || o.nonce === offer.nonce) continue;
			const rem = BigInt(o.size) - (fills.get(o.nonce)?.filled ?? 0n);
			if (rem > 0n) resting += rem;
		}
		return resting <= free;
	}

	/** Ingest an intent gossiped by a peer (or a peer's whole book on connect). Verifies the
	 *  maker signature, drops offers the maker can't back (the early ghost-check), and dedupes by
	 *  nonce; returns true if it was NEW (so the node re-floods). */
	private receiveIntent(offer: Offer): boolean {
		if (!offer || this.offers.has(offer.nonce)) return false;
		if (!verifyOffer(offer)) return false;
		if (!this.canBack(offer)) return false; // drop unbacked/over-committed offers — they'd fail to match
		this.offers.set(offer.nonce, offer);
		return true;
	}

	/** Live tape: resting offers with their remaining (unfilled) size, freshest first. Doubles
	 *  as the gossip-tape GC — fully-filled or expired offers are evicted from the local book
	 *  (it's RAM-only, non-consensus, but should still not grow with every offer ever seen). */
	intentTape(): { nonce: string; maker: string; side: Side; remaining: string; leverage: string; mine: boolean }[] {
		const fills = this.view().book.offerFills;
		const me = this.wallet.active().pubHex;
		const height = this.node.anchorTip()?.height ?? 0;
		const out: { nonce: string; maker: string; side: Side; remaining: string; leverage: string; mine: boolean }[] = [];
		for (const o of [...this.offers.values()].reverse()) {
			const remaining = BigInt(o.size) - (fills.get(o.nonce)?.filled ?? 0n);
			if (remaining <= 0n || height > o.expiryHeight) {
				this.offers.delete(o.nonce); // retire filled/expired offers from the local tape
				continue;
			}
			out.push({ nonce: o.nonce, maker: o.maker, side: o.makerSide, remaining: remaining.toString(), leverage: o.leverage, mine: o.maker === me });
		}
		return out;
	}

	/** Take a specific resting intent from the active account → opens a matched contract. */
	async takeIntent(nonce: string, fill?: string): Promise<string> {
		const offer = this.offers.get(nonce);
		if (!offer) throw new Error("that intent is no longer available");
		if (offer.maker === this.wallet.active().pubHex) throw new Error("you can't take your own intent — switch to another account");
		const remaining = BigInt(offer.size) - (this.view().book.offerFills.get(nonce)?.filled ?? 0n);
		const want = fill ? BigInt(fill) : remaining;
		const take = want < remaining ? want : remaining;
		if (take <= 0n) throw new Error("that intent is fully taken");
		if (this.active().gbtc() < take) throw new Error(`insufficient gBTC: you need ${take} to take this`);
		const id = await this.active().matchOpen(offer, take);
		// applyMatch no-ops (returns no contract) if the MAKER ghosted (spent its collateral).
		if (!this.view().book.contracts.has(id)) {
			this.offers.delete(nonce); // drop the dead offer
			throw new Error("the maker no longer has the collateral — intent withdrawn");
		}
		return id;
	}

	/** gBTC the liquidity backstop can stake right now: its FINALIZED capital (the checkpoint
	 *  base's free pot + lifetime draws — the deterministic budget) minus what it has already
	 *  drawn in the live view. 0 before the first checkpoint. */
	backstopAvailable(view = this.view()): bigint {
		const base = this.checkpointBase;
		if (!base) return 0n;
		const budget = base.bridge.pot + base.bridge.potEscrowTaken;
		const avail = budget - view.bridge.potEscrowTaken;
		return avail > 0n ? avail : 0n;
	}

	/** Easy taker: go long/short by `size`, sweeping the best OPPOSITE resting intents first,
	 *  then falling back to the liquidity BACKSTOP (the idle-decay pot) for any remainder — so a
	 *  trade can be placed even with no peer on the other side. `leverage` applies to the backstop
	 *  leg (default 2×); peer fills keep the maker's offered leverage. */
	async takePosition(side: Side, size: string, leverage = "2"): Promise<{ filled: string; contracts: string[]; viaBackstop: string }> {
		const want = BigInt(size);
		const opposite: Side = side === "long" ? "short" : "long";
		const me = this.wallet.active().pubHex;
		let left = want;
		const contracts: string[] = [];
		for (const t of this.intentTape()) {
			if (left <= 0n) break;
			if (t.side !== opposite || t.maker === me) continue; // opposite side, not me
			const take = left < BigInt(t.remaining) ? left : BigInt(t.remaining);
			try {
				contracts.push(await this.takeIntent(t.nonce, take.toString()));
				left -= take;
			} catch {
				/* raced away — skip */
			}
		}
		// No peer (or not enough) → let the pot take the other side, capped by its finalized budget.
		let viaBackstop = 0n;
		if (left > 0n) {
			const avail = this.backstopAvailable();
			let take = left < avail ? left : avail;
			if (take > this.active().gbtc()) take = this.active().gbtc();
			if (take > 0n) {
				try {
					const id = await this.active().takePot(side, take, leverage);
					if (this.view().book.contracts.has(id)) {
						contracts.push(id);
						left -= take;
						viaBackstop = take;
					}
				} catch {
					/* budget/coverage raced — skip */
				}
			}
		}
		if (contracts.length === 0) throw new Error(`no ${opposite} intents on the tape and the backstop pot is dry — broadcast an intent or wait for a peer`);
		return { filled: (want - left).toString(), contracts, viaBackstop: viaBackstop.toString() };
	}

	/** Close (settle) a matched contract at the current mark, from the active account. */
	async settleContract(contractId: string): Promise<void> {
		await this.active().settle(contractId);
	}

	/** The active account's open matched contracts, with live PnL at the current mark. */
	myContracts(): { id: string; side: Side; stake: string; entry: string; leverage: string; counterparty: string; pnl: string | null; expiryHeight: number; expiresIn: number | null }[] {
		const v = this.view();
		const m = mark(v); // the channel's single market mark
		const me = this.wallet.active().pubHex;
		const height = this.node.anchorTip()?.height ?? 0;
		const out: { id: string; side: Side; stake: string; entry: string; leverage: string; counterparty: string; pnl: string | null; expiryHeight: number; expiresIn: number | null }[] = [];
		for (const c of v.book.contracts.values()) {
			const iAmLong = c.long === me;
			if (!iAmLong && c.short !== me) continue;
			let pnl: string | null = null;
			if (m !== null) {
				const longGets = longPayout(c.stake, c.entry, c.leverage, m);
				const mine = iAmLong ? longGets : c.stake * 2n - longGets;
				pnl = (mine - c.stake).toString();
			}
			out.push({ id: c.id, side: iAmLong ? "long" : "short", stake: c.stake.toString(), entry: c.entry.toString(), leverage: c.leverage.toString(), counterparty: iAmLong ? c.short : c.long, pnl, expiryHeight: c.expiryHeight, expiresIn: height > 0 ? Math.max(0, c.expiryHeight - height) : null });
		}
		return out;
	}

	/** Finality-bound view: only state the anchor chain has certified `finalityDepth` deep.
	 *  Resumes from the checkpoint base; memoized on the finalized anchor id. */
	finalView(): View {
		if (!this.node.anchors) return this.checkpointBase ? computeView([], { base: this.checkpointBase }) : computeView([]);
		const finId = this.node.anchors.finalized(this.finalityDepth)?.id ?? null;
		if (this.finalCache && this.finalCache.id === finId) return this.finalCache.view;
		const view = finalizedView(this.node.ledger.allWrites(), this.node.anchors, this.finalityDepth, this.checkpointBase, this.channelMarket());
		this.finalCache = { id: finId, view };
		return view;
	}

	/** Current "now" on the anchor clock — the finalized anchor's height, or null pre-consensus. */
	finalizedHeight(): number | null {
		return this.node.anchors?.finalized(this.finalityDepth)?.height ?? null;
	}

	/** Custody status for the UI/operator: the mode, the autonomous loop's epoch, the
	 *  on-chain fund key/address, and whether THIS node currently holds a committee share. */
	custodyStatus(): {
		mode: "committee";
		epoch: number;
		fundKeyOnChain: string | null;
		fundAddress: string | null;
		committeeId: string | null;
		holdsShare: boolean;
		committee: string[] | null;
		threshold: number | null;
		minCommittee: number;
		subSwarmTopics: string[];
		bonded: boolean;
		myBond: string;
	} {
		const cs = this.committeeShare();
		const onchain = this.view().custody.fundKey; // the announced committee group key (null until genesis DKG completes)
		const id = this.producerId();
		return {
			mode: "committee",
			epoch: this.rotation?.epoch ?? -1,
			fundKeyOnChain: onchain,
			fundAddress: this.fundAddress(), // null pre-genesis (no key yet)
			committeeId: id,
			holdsShare: !!cs,
			committee: cs?.participants ?? null,
			threshold: cs?.min ?? null,
			minCommittee: this.custodyOpts.minCommittee ?? 3, // farmers needed to bootstrap genesis custody
			subSwarmTopics: this.transport?.committeeTopicNames() ?? [],
			bonded: !!this.custodyOpts.bonded, // stake-weighted selection on?
			myBond: (this.view().bridge.bonds.get(id) ?? 0n).toString(),
		};
	}

	/** Lock `amount` gBTC at THIS node's committee identity as a bond (stake-weighted
	 *  selection; slashable). The gBTC must already sit at producerId() — fund it with a
	 *  gbtc.transfer first. Returns the bond write id. */
	async bondCustody(amount: bigint): Promise<string> {
		return (await this.custodyAccount().bond(amount)).id;
	}
	/** Release `amount` of this node's bond back to spendable gBTC. */
	async unbondCustody(amount: bigint): Promise<string> {
		return (await this.custodyAccount().unbond(amount)).id;
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
			pinnedPeers: this.knownPeers.list(),
			bootstrap: this.bootstrap.asStrings().map((node) => ({ node, default: this.bootstrap.isDefault(node) })),
		};
	}

	/** Build the swarm transport, join the current channel's topic, re-dial pinned peers.
	 *  Resilient to a slow/absent DHT (soft 8s cap) — falls back to local if it fails. */
	private async joinMesh(): Promise<void> {
		try {
			// Custom bootstrap nodes (the DHT entry/"DNS" layer) are added alongside
			// Holepunch's defaults; undefined → defaults only.
			this.transport = new SwarmTransport(this.node, { bootstrap: this.bootstrap.forSwarm(), keyPair: this.swarmKeyPair() });
			const joined = this.transport.join(this.network); // resolved channel, not a param
			await Promise.race([joined, new Promise((r) => setTimeout(r, 8000))]);
			// Re-dial pinned peers directly (independent of DHT discovery) — eclipse resistance.
			for (const key of this.knownPeers.list()) {
				try {
					this.transport.dialPeer(key);
				} catch {
					/* skip a malformed pin */
				}
			}
		} catch (e) {
			console.warn(`[daemon] mesh join failed (continuing local): ${(e as Error).message}`);
			this.transport = undefined;
		}
	}

	/** Join the live mesh and (optionally) start farming anchors. Resilient to a missing network. */
	async startConsensus(opts: { network?: string; mesh: boolean; farm: boolean; publishOracle?: { everyMs: number } }): Promise<void> {
		if (opts.network) this.network = opts.network;
		this.meshOn = opts.mesh;
		this.farmOn = opts.farm;

		if (opts.mesh) await this.joinMesh();

		if (opts.publishOracle) {
			this.oraclePublishOpts = opts.publishOracle; // remember so a channel switch re-publishes
			this.startOraclePublisher(opts.publishOracle);
		}
		this.startReserveWatch(); // proof-of-reserves polling

		if (opts.farm) {
			// Stable producer identity (persisted) so this node is the SAME committee
			// candidate across reboots — its anchor-producer pubkey IS its committee id.
			const farmer = this.producerKey(); // stable producer identity = this node's committee id
			let prover: SpaceProver;
			if (this.spaceMode === "chiapos") {
				// Real disk cost: plot the farmer's chiapos plot (slow the first time, then cached).
				const pub = toHex(farmer.publicKey);
				const plotPath = ensurePlot(pub, this.k, this.plotDir);
				prover = new ChiaSpaceProver({ pubHex: pub, k: this.k, plotPath });
			} else {
				prover = new StandinSpaceProver(new Plot(farmer.publicKey, this.k));
			}
			this.producer = new Producer({ node: this.node, keypair: farmer, prover, params: this.params, appRootFor: (prev) => this.appRootForParent(prev) });
			this.farming = true;
			this.startCommitteeCustody(); // the only custody path: form/join the M-of-N committee

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

	/** Stand up the autonomous custody loop: it watches finality (via node.onTip →
	 *  driveRotation) and runs genesis DKG / per-epoch reshare across the PoST-weighted
	 *  committee sampled from the chain. The fund key is published on-chain at genesis. */
	private startCommitteeCustody(): void {
		if (this.rotation) return;
		this.rotation = new CommitteeRotation({
			node: this.node,
			selfId: this.producerId(),
			epochLength: this.custodyOpts.epochLength ?? 16,
			size: this.custodyOpts.size ?? 5,
			genesisSize: this.custodyOpts.genesisSize ?? this.custodyOpts.minCommittee ?? 3, // small n-of-n genesis, grown after
			minCommittee: this.custodyOpts.minCommittee ?? 3,
			timeoutMs: this.custodyOpts.ceremonyTimeoutMs ?? 30_000,
			windowAnchors: this.custodyOpts.windowAnchors,
			bonds: this.custodyOpts.bonded ? () => this.finalView().bridge.bonds : undefined, // stake-weighted selection
			auth: this.ceremonyAuth(),
			ceremonySeed: () => this.producerKey().privateKey, // deterministic DKG material across retries

			groupKey: () => {
				const hex = this.view().custody.fundKey;
				return hex ? fromHex(hex) : null;
			},
			fundEpoch: () => {
				const e = this.view().custody.epoch;
				return e >= 0 ? e : null; // -1 until genesis publishes; then the genesis epoch
			},
			publishFund: (key, epoch) => void this.custodyAccount().announceFund(toHex(key), epoch).catch(() => {}),
			loadShare: () => this.committeeShare(),
			saveShare: (s) => saveShare(this.sharePath(), s),
			clearShare: () => {
				try {
					rmSync(this.sharePath(), { force: true }); // rotated out → the share is dead; remove it
				} catch {
					/* best effort */
				}
			},
			log: (m) => console.log(m),
		});

		// Auto-slashing: watch every ceremony message this node sees; when a committee
		// member equivocates (two conflicting signed messages for one slot), file the
		// fraud proof — but only if the culprit has stake to lose (else it's a wasted write).
		this.equivWatcher = new EquivocationWatcher((a, b, culprit) => {
			if (slashable(this.view().bridge, culprit) <= 0n) return;
			console.log(`[custody] equivocation by ${culprit.slice(0, 16)}… → submitting slash`);
			void this.custodyAccount().slash(a, b).catch(() => {});
		});
		this.node.onCeremonyMessage = (m) => this.equivWatcher!.observe(m);

		console.log(`  custody: committee mode (epochLength ${this.custodyOpts.epochLength ?? 16}, size ${this.custodyOpts.size ?? 5}); id ${this.producerId().slice(0, 16)}…`);
	}

	/**
	 * Relay THIS channel's price on a loop. A CHANNEL IS A MARKET with NO reporter — any node may
	 * relay, an M-of-N quorum signature is the authority, and the fold re-verifies the bytes:
	 *   • `label::pyth::feedId`   → the latest Wormhole-attested update from Hermes (13-of-19 guardians).
	 *   • `label::signed::setHash` → the latest quorum-signed update from the set's aggregator endpoint
	 *                                (GAVL_FEED_URL); the committed signer set is the trust anchor.
	 * Post it whenever the publish-time advances; other nodes fold + verify the quorum independently.
	 */
	private startOraclePublisher(opts: { everyMs: number }): void {
		const acct = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: this.producerKey() });
		const def = parseChannel(this.network);
		this.publishing = true;
		const myGen = ++this.oracleGen; // a channel switch bumps this → the old loop below exits
		if (!def) {
			console.log(`  channel ${this.network}: not a market channel — no price`);
			return;
		}
		if (def.kind === "pyth") this.relayPyth(acct, def.feedId, def.label, myGen, opts.everyMs);
		else this.relaySigned(acct, def.signerSet, def.label, myGen, opts.everyMs);
	}

	/** Relay loop for a Pyth market: Hermes → verify the guardian quorum + Merkle proof → post when
	 *  the attested publish-time advances. Hermes is untrusted transport; the guardians are the authority. */
	private relayPyth(acct: Account, feedId: string, label: string, myGen: number, everyMs: number): void {
		void (async () => {
			let lastPub = this.view().market.seq; // last on-chain publish time
			while (this.publishing && myGen === this.oracleGen) {
				const blob = await fetchPythUpdate(feedId);
				const p = blob ? verifyPythUpdate(blob).find((x) => x.feedId === feedId) : null;
				if (p && p.price > 0n) {
					this.lastOracleSource = { value: p.price, method: `Pyth ${feedId.slice(0, 10)}…`, used: 1, readings: [{ value: p.price, raw: `${p.price}e${p.expo}`, endpoint: HERMES_URL, key: feedId }], at: Date.now() };
					if (p.publishTime > lastPub) {
						try {
							await acct.reportMarketUpdate(blob!); // newer attested update → relay it
							lastPub = p.publishTime;
						} catch {
							/* retry next tick */
						}
					}
				}
				await new Promise((res) => setTimeout(res, everyMs));
			}
		})();
		console.log(`  market ${label}: relaying Pyth feed ${feedId.slice(0, 10)}… from Hermes (verified on-chain; no reporter)`);
	}

	/** Relay loop for a generic SIGNED market: fetch the latest quorum-signed update from the set's
	 *  aggregator endpoint (GAVL_FEED_URL), verify the M-of-N quorum against the channel's committed
	 *  set hash, and post when the publish-time advances. No URL ⇒ this node only TRADES on updates
	 *  others relay (it never forges — the fold rejects anything not signed by a quorum of the set). */
	private relaySigned(acct: Account, signerSet: string, label: string, myGen: number, everyMs: number): void {
		const url = process.env.GAVL_FEED_URL;
		if (!url) {
			console.log(`  market ${label}: signed set ${signerSet.slice(0, 10)}… — set GAVL_FEED_URL to relay it (trading on others' relays either way)`);
			return;
		}
		void (async () => {
			let lastPub = this.view().market.seq; // last on-chain publish time
			while (this.publishing && myGen === this.oracleGen) {
				const raw = await fetchSignedUpdate(url);
				const r = raw != null ? verifySignedQuorum(raw, signerSet) : null;
				if (r && r.price > 0n) {
					this.lastOracleSource = { value: r.price, method: `signed ${signerSet.slice(0, 10)}…`, used: 1, readings: [{ value: r.price, raw: `${r.price}e${r.expo}`, endpoint: url, key: signerSet }], at: Date.now() };
					if (r.publishTime > lastPub) {
						try {
							await acct.reportMarketUpdate(JSON.stringify(raw)); // genuine quorum-signed update → relay it
							lastPub = r.publishTime;
						} catch {
							/* retry next tick */
						}
					}
				} else if (raw != null) {
					// the endpoint answered but the update didn't meet the channel's committed quorum
					this.lastOracleSource = { value: null, method: `signed ${signerSet.slice(0, 10)}…`, used: 0, readings: [{ value: null, raw: null, endpoint: url, key: signerSet, error: "update didn't meet this channel's committed signer-set quorum" }], at: Date.now() };
				}
				await new Promise((res) => setTimeout(res, everyMs));
			}
		})();
		console.log(`  market ${label}: relaying signed set ${signerSet.slice(0, 10)}… from ${url} (quorum-verified on-chain; no reporter)`);
	}

	/** The publisher's latest aggregate reading (per-source endpoint/key/raw/value +
	 *  the average), or null if this node isn't publishing. Local metadata, never on-chain. */
	oracleSource(): (AggregateReading & { at: number }) | null {
		return this.lastOracleSource;
	}

	// ── real-BTC bridge (testnet) ────────────────────────────────────

	/** The threshold-custody fund key — ALWAYS the committee's; there is no single-key/solo path on
	 *  any network. The group key is the ON-CHAIN published one (so any node, even one holding no
	 *  share, derives the right address); if this node holds the matching share, pub/min are exposed
	 *  for co-signing. Returns NULL pre-genesis: until the committee runs its DKG there is no fund
	 *  key, no address, and nothing can be minted — a lone node simply waits for peers. */
	private fundKey(): FundKey | null {
		const onchain = this.view().custody.fundKey;
		const cs = this.committeeShare();
		if (onchain) {
			const groupPubKey = fromHex(onchain);
			if (cs && toHex(cs.groupPubKey) === onchain) return { groupPubKey, pub: cs.pub, shares: {}, min: cs.min, max: cs.participants.length };
			return { groupPubKey, pub: {} as FundKey["pub"], shares: {}, min: 0, max: 0 }; // address-only (no share here)
		}
		if (cs) return { groupPubKey: cs.groupPubKey, pub: cs.pub, shares: {}, min: cs.min, max: cs.participants.length }; // hold a share; genesis announce not seen yet
		return null; // pre-genesis: no committee fund exists yet
	}

	/** Path to THIS node's persisted committee share (secret, node-local). */
	private sharePath(): string {
		return join(this.dataDir, "custody", "share.json");
	}
	/** This node's committee share if it holds one (from DKG or a reshare), else null. */
	committeeShare(): StoredShare | null {
		return loadShare(this.sharePath());
	}

	/** This node's STABLE anchor-producer key (persisted) — also its committee identity.
	 *  A fresh key each boot would make the node a different committee candidate every
	 *  restart and forfeit its seat/share, so it's pinned to disk like the wallet seed. */
	private producerKeyPath(): string {
		return join(this.dataDir, "custody", "farmer.json");
	}
	private producerKey(): KeyPair {
		if (this.producerKeyCache) return this.producerKeyCache;
		const path = this.producerKeyPath();
		if (existsSync(path)) {
			this.producerKeyCache = keyPairFromSeed(fromHex(JSON.parse(readFileSync(path, "utf8")).seed));
		} else {
			const kp = generateKeyPair();
			mkdirSync(join(this.dataDir, "custody"), { recursive: true });
			writeFileSync(path, JSON.stringify({ seed: toHex(kp.privateKey) }), { mode: 0o600 }); // privateKey IS the 32-byte seed
			this.producerKeyCache = kp;
		}
		return this.producerKeyCache;
	}

	/** This node's STABLE Hyperswarm/Noise keypair (persisted). Without this Hyperswarm mints a fresh
	 *  identity every boot, so this node's nodeKey changes each restart and any direct-dial pin from a
	 *  peer goes stale. Pinned to disk (like the producer key) so a restart keeps the same nodeKey. */
	private swarmKeyCache?: { publicKey: Buffer; secretKey: Buffer };
	private swarmKeyPair(): { publicKey: Buffer; secretKey: Buffer } {
		if (this.swarmKeyCache) return this.swarmKeyCache;
		const path = join(this.dataDir, "swarm-key.json");
		let seed: Buffer;
		if (existsSync(path)) {
			seed = Buffer.from(fromHex(JSON.parse(readFileSync(path, "utf8")).seed));
		} else {
			seed = Buffer.from(generateKeyPair().privateKey); // 32-byte seed
			mkdirSync(this.dataDir, { recursive: true });
			writeFileSync(path, JSON.stringify({ seed: seed.toString("hex") }), { mode: 0o600 });
		}
		this.swarmKeyCache = swarmKeyPair(seed);
		return this.swarmKeyCache;
	}

	/** This node's committee id (stable producer pubkey hex). */
	producerId(): string {
		return toHex(this.producerKey().publicKey);
	}

	/** Account bound to the producer key — used to announce the fund key on-chain. */
	private custodyAccount(): Account {
		if (!this.custodyAcct) this.custodyAcct = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: this.producerKey() });
		return this.custodyAcct;
	}

	/** Authenticates this node's ceremony messages (signs as its committee id = producer
	 *  pubkey) and verifies peers' — so an impersonator on the committee topic is dropped. */
	private ceremonyAuthCache?: CeremonyAuth;
	private ceremonyAuth(): CeremonyAuth {
		if (!this.ceremonyAuthCache) this.ceremonyAuthCache = makeCeremonyAuth(this.producerKey().privateKey);
		return this.ceremonyAuthCache;
	}

	/**
	 * Produce a COMMITTEE threshold signature over an attestation `digest` (gate #4) —
	 * the authority for an on-chain mint/settle, replacing the single attestor key. This
	 * node co-signs with its share over the committee ceremony (deterministic first
	 * quorum), so the same digest yields the same ceremony on every member and they
	 * converge on one signature. Returns the sig hex, or null if this node isn't a
	 * quorum signer this round / the quorum couldn't be reached (caller retries).
	 *
	 * As with withdrawals, every member should INDEPENDENTLY verify the underlying fact
	 * (the deposit landed / the payout confirmed, via Esplora) before co-signing — that
	 * check is the caller's (claimDeposit / settle). Autonomous multi-node triggering of
	 * the ceremony is the same coordination layer withdrawals need (next).
	 */
	private async committeeAttest(digest: Uint8Array): Promise<string | null> {
		const cs = this.committeeShare();
		if (!cs) return null;
		const quorum = quorumForRound(cs.participants, cs.min, 0);
		if (!quorum.includes(cs.selfId)) return null; // not a signer this round
		try {
			const coord = new SignCoordinator(this.node, {
				signId: `attest:${toHex(sha256(digest))}`, // same digest → same ceremony on every member
				selfId: cs.selfId,
				quorum,
				pub: cs.pub,
				share: cs.share,
				message: digest,
				timeoutMs: this.custodyOpts.ceremonyTimeoutMs ?? 30_000,
				auth: this.ceremonyAuth(),
			});
			return toHex(await coord.start());
		} catch (e) {
			if (isCeremonyTimeout(e)) return null; // quorum not reachable — retry later
			throw e;
		}
	}

	/**
	 * Run the distributed committee DKG over the LIVE node transport with the
	 * configured committee, then persist THIS node's share (the key is generated
	 * across the committee — no node ever holds it whole). Operator-triggered once
	 * all committee members are connected. `selfId` must be this node's committee id.
	 *
	 * NOTE: the ceremony is proven over the in-memory transport (which mimics the
	 * wire); running it across real hyperdht daemons is a live-deployment step. This
	 * wires the proven coordinator onto `this.node`'s real connections.
	 */
	async runCommitteeDkg(opts: { session: string; selfId: string; participants: string[]; min: number }): Promise<string> {
		const coord = new DkgCoordinator(this.node, opts);
		const result = await coord.start();
		saveShare(this.sharePath(), { ...result, session: opts.session, selfId: opts.selfId, participants: opts.participants, min: opts.min });
		return deriveFundAddress({ groupPubKey: result.groupPubKey, pub: result.pub, shares: {}, min: opts.min, max: opts.participants.length }, this.btcNetwork());
	}
	private esploraCache?: Esplora;
	private esplora(): Esplora {
		const net = process.env.GAVL_BTC_NET === "signet" ? "signet" : process.env.GAVL_BTC_NET === "mainnet" ? "mainnet" : "testnet";
		if (!this.esploraCache || this.esploraCache.net !== net) this.esploraCache = new Esplora({ net });
		return this.esploraCache;
	}
	/** Which Bitcoin network the bridge is on (testnet by default). */
	btcNetwork(): "mainnet" | "testnet" | "signet" {
		return this.esplora().net;
	}
	/** The base fund address (change + legacy + consolidation). Per-user deposits go to
	 *  `depositAddressFor` instead — see the front-running fix. NULL pre-genesis (no committee
	 *  fund key yet), so deposits/withdrawals are impossible until the committee forms. */
	fundAddress(): string | null {
		const fk = this.fundKey();
		return fk ? deriveFundAddress(fk, this.btcNetwork()) : null;
	}

	/** A user's OWN Bitcoin deposit address — derived from (fund key, their pubkey), so a
	 *  deposit here is cryptographically bound to them and can't be claimed by anyone else.
	 *  NULL pre-genesis (no fund key) — there's nowhere to deposit until the committee forms. */
	depositAddressFor(pubHex: string): string | null {
		const fk = this.fundKey();
		return fk ? depositAddress(fk.groupPubKey, pubHex, this.btcNetwork()) : null;
	}

	/** Every address the fund holds BTC at: the base, plus each depositor's per-user
	 *  address (`owner` = the depositor, telling the signer which tweak to use). */
	private fundAddresses(): { address: string; owner?: string }[] {
		const base = this.fundAddress();
		const list: { address: string; owner?: string }[] = base ? [{ address: base }] : []; // empty pre-genesis
		for (const d of this.view().bridge.depositors) {
			const addr = this.depositAddressFor(d);
			if (addr) list.push({ address: addr, owner: d });
		}
		return list;
	}

	/**
	 * PROOF OF RESERVES: the REAL confirmed BTC in the fund (sum of on-chain UTXOs),
	 * cached + refreshed on a timer so reads are sync. Compared against the ledger's
	 * `reserves` to detect under-backing (the safety check a custodial bridge must run).
	 */
	private onChainReserves: { sats: bigint; at: number } | null = null;
	private reserveTimer?: ReturnType<typeof setInterval>;
	async refreshOnChainReserves(): Promise<void> {
		try {
			const esplora = this.esplora();
			let sats = 0n;
			for (const { address } of this.fundAddresses()) {
				const utxos = await esplora.utxos(address);
				for (const u of utxos) if (u.status.confirmed) sats += BigInt(u.value);
			}
			this.onChainReserves = { sats, at: Date.now() };
		} catch {
			/* network hiccup — keep the last reading */
		}
	}
	onChainReservesCached(): { sats: bigint; at: number } | null {
		return this.onChainReserves;
	}
	private startReserveWatch(): void {
		if (this.reserveTimer) return; // once
		void this.refreshOnChainReserves();
		this.reserveTimer = setInterval(() => void this.refreshOnChainReserves(), 30_000);
	}

	/**
	 * Begin claiming a real BTC deposit `txid` for `depositor` (verified to have paid THEIR
	 * per-user address). This only posts the on-chain `bridge.claim` TRIGGER — the committee
	 * then independently re-verifies + co-signs the mint, so no single key ever mints. No-op
	 * (returns 0) pre-genesis: with no committee fund there's no deposit address and nothing
	 * to claim. Returns the sats found (the gBTC appears once the committee mints).
	 */
	async claimDeposit(txid: string, depositor: string): Promise<bigint> {
		// FRONT-RUN FIX: verify the deposit paid the CLAIMER's OWN per-user address. The strict
		// per-user binding is the committee front-running guard — there is no fund-address fallback.
		const addr = this.depositAddressFor(depositor);
		if (!addr || !this.view().custody.fundKey) return 0n; // no committee fund yet — nothing to claim against
		const deps = await checkDeposit(this.esplora(), addr, txid, MIN_CONFIRMATIONS);
		let total = 0n;
		for (const d of deps) {
			const depositId = `${d.txid}:${d.vout}`;
			await this.custodyAccount().claim(depositId, depositor); // post the trigger; the committee re-verifies + co-signs the mint
			total += d.amount;
		}
		return total;
	}

	/**
	 * Settle pending withdrawals by co-signing the unsent ones (the finality loop also does this
	 * autonomously). Returns the broadcast txid of the batch, or null (incl. pre-genesis: no fund).
	 */
	async processWithdrawals(): Promise<string | null> {
		if (!this.view().custody.fundKey) return null; // no committee fund yet
		return this.coSignWithdrawals();
	}

	/**
	 * Gather the fund's confirmed UTXOs and build a deterministic payout tx to `targets`
	 * (+ change back to the fund, − fee). Enforces the SIGNING POLICY (the honest-member
	 * veto): the only non-change outputs are the requested withdrawal addresses. Returns a
	 * rebuild thunk (finalizing a PSBT consumes it) + the txid-to-be, or null if there
	 * isn't enough confirmed BTC yet.
	 */
	private async buildPayout(targets: { id: string; btcAddress: string; amount: bigint }[], feeSats: bigint): Promise<{ mkUnsigned: () => ReturnType<typeof buildWithdrawalTx> } | null> {
		const fk = this.fundKey();
		const fundAddr = this.fundAddress();
		if (!fk || !fundAddr) return null; // no committee fund yet — nothing to sign against
		const esplora = this.esplora();
		const tip = await esplora.tipHeight();
		const inputs = (await Promise.all(this.fundAddresses().map(async ({ address, owner }) => utxosToInputs(await esplora.utxos(address), MIN_CONFIRMATIONS, tip).map((u) => ({ ...u, owner }))))).flat();
		const inSum = inputs.reduce((a, u) => a + u.amount, 0n);
		const payouts = targets.map((w) => ({ address: w.btcAddress, amount: w.amount }));
		const outSum = payouts.reduce((a, p) => a + p.amount, 0n);
		if (inputs.length === 0 || inSum < outSum + feeSats) return null;
		const change = inSum - outSum - feeSats;
		if (change > 0n) payouts.push({ address: fundAddr, amount: change });
		// VETO: the tx may pay ONLY the requested withdrawal addresses + change to the fund.
		const requested = new Set(targets.map((w) => w.btcAddress));
		for (const p of payouts) if (p.address !== fundAddr && !requested.has(p.address)) throw new Error(`withdrawal policy: refusing to pay ${p.address}`);
		inputs.sort((a, b) => (a.txid === b.txid ? a.index - b.index : a.txid < b.txid ? -1 : 1));
		payouts.sort((a, b) => (a.address === b.address ? Number(a.amount - b.amount) : a.address < b.address ? -1 : 1));
		return { mkUnsigned: () => buildWithdrawalTx(fk, { inputs, outputs: payouts, network: this.btcNetwork() }) };
	}

	// ── autonomous committee co-signing (finality-driven; the trigger) ───────

	private authorizing = false;
	/**
	 * On each finality advance, a committee member picks up ALL pending custody work from
	 * FINALIZED state and co-signs it — withdrawals to sign, deposits to mint, payouts to
	 * settle — with NO leader: every member reads the same finalized state, runs the same
	 * deterministic ceremony per item, and idempotent effects make duplicates safe. This
	 * is what makes the committee autonomous across many nodes. No-op unless this node holds
	 * a share + a fund exists. Non-reentrant.
	 */
	private maybeAuthorizePending(): void {
		if (this.authorizing || !this.committeeShare() || !this.view().custody.fundKey) return;
		this.authorizing = true;
		void (async () => {
			try {
				await this.coSignWithdrawals();
				await this.coMintClaims();
				await this.coSettleConfirmed();
			} catch (e) {
				console.warn(`[custody] authorize: ${(e as Error).message}`);
			} finally {
				this.authorizing = false;
			}
		})();
	}

	/** Co-sign + broadcast the UNSENT finalized withdrawals (one batch), then post a
	 *  bridge.broadcast note per withdrawal so the committee stops re-signing them. */
	private async coSignWithdrawals(): Promise<string | null> {
		const cs = this.committeeShare();
		if (!cs) return null;
		const unsent = unsentWithdrawals(this.finalView().bridge);
		if (unsent.length === 0) return null;
		const built = await this.buildPayout(unsent, 1_000n);
		if (!built) return null;
		const signed = await signWithdrawalWithFailover(built.mkUnsigned, {
			node: this.node,
			signIdBase: unsent.map((w) => w.id).join(","),
			selfId: cs.selfId,
			committee: cs.participants,
			min: cs.min,
			pub: cs.pub,
			groupPubKey: cs.groupPubKey,
			share: cs.share,
			timeoutMs: this.custodyOpts.ceremonyTimeoutMs ?? 30_000,
			auth: this.ceremonyAuth(),
		});
		if (!signed) return null; // quorum not reached this round — retried next finality tick
		await this.esplora().broadcast(signed.hex);
		for (const w of unsent) await this.custodyAccount().announceBroadcast(w.id, signed.txid); // mark in flight
		return signed.txid;
	}

	/** For each finalized deposit-claim, INDEPENDENTLY verify it on-chain, then co-sign the
	 *  mint (committee threshold). A bogus claim fails verification and mints nothing. */
	private async coMintClaims(): Promise<void> {
		const claims = pendingClaims(this.finalView().bridge);
		if (claims.length === 0) return;
		const esplora = this.esplora();
		for (const { depositId, depositor } of claims) {
			const colon = depositId.lastIndexOf(":");
			if (colon < 0) continue;
			const txid = depositId.slice(0, colon);
			const vout = Number(depositId.slice(colon + 1));
			const addr = this.depositAddressFor(depositor);
			if (!addr) continue; // no fund key — can't derive the per-user address
			const deps = await checkDeposit(esplora, addr, txid, MIN_CONFIRMATIONS);
			const d = deps.find((x) => x.vout === vout);
			if (!d) continue; // not verified (yet) — retried next tick
			const sig = await this.committeeAttest(depositAttestationDigest({ depositId, depositor, amount: d.amount }));
			if (sig) await this.custodyAccount().attestDeposit(depositId, depositor, d.amount, sig);
		}
	}

	/** For each in-flight withdrawal whose payout txid has confirmed on-chain, co-sign the
	 *  settle (committee threshold) so reserves drop. */
	private async coSettleConfirmed(): Promise<void> {
		const inFlight = inFlightWithdrawals(this.finalView().bridge);
		if (inFlight.length === 0) return;
		const esplora = this.esplora();
		const tip = await esplora.tipHeight();
		for (const { withdrawal, txid } of inFlight) {
			const tx = await esplora.getTx(txid);
			if (!tx || confirmations(tx, tip) < MIN_CONFIRMATIONS) continue; // not confirmed yet
			const sig = await this.committeeAttest(settleAttestationDigest({ withdrawalId: withdrawal.id }));
			if (sig) await this.custodyAccount().settleWithdrawal(withdrawal.id, sig);
		}
	}

	/** The channel/network this node is currently on. */
	currentChannel(): string {
		return this.network;
	}

	// ── identity control ─────────────────────────────────────────────

	/** Reroll: create a fresh identity and make it active. Returns its pubkey. */
	rerollIdentity(label?: string): string {
		const acct = this.wallet.create(label || `identity ${this.wallet.list().length + 1}`);
		this.bind(acct);
		return acct.pubHex;
	}

	/** Import an identity from a 32-byte seed (hex), make it active. Returns its pubkey. */
	importIdentity(seedHex: string, label?: string): string {
		const acct = this.wallet.importSeed(seedHex, label);
		this.bind(acct);
		return acct.pubHex;
	}

	/** Export the active identity's seed (private key, hex). Handle with care. */
	exportActiveSeed(): string {
		return this.wallet.exportSeed(this.wallet.active().pubHex);
	}

	// ── peer control ─────────────────────────────────────────────────

	/** Dial a peer by node-key now; if `pin`, also persist it for re-dial on every boot. */
	dialPeer(nodeKeyHex: string, pin = true): void {
		if (pin) this.knownPeers.add(nodeKeyHex);
		this.transport?.dialPeer(nodeKeyHex); // no-op if mesh is off; the pin still applies next boot
	}

	/** Unpin a known peer (stops re-dialing it on boot; doesn't drop a live connection). */
	unpinPeer(nodeKeyHex: string): boolean {
		return this.knownPeers.remove(nodeKeyHex);
	}

	/** Pinned peer node-keys (re-dialed every boot). */
	pinnedPeers(): string[] {
		return this.knownPeers.list();
	}

	// ── bootstrap control (the DHT "DNS"/entry layer) ────────────────

	/** Custom bootstrap nodes as "host:port" strings (added alongside Holepunch defaults). */
	bootstrapNodes(): string[] {
		return this.bootstrap.asStrings();
	}

	/** Add a custom bootstrap node ("host:port") and reconnect to the DHT through it. */
	async addBootstrap(hostPort: string): Promise<void> {
		if (!this.bootstrap.add(hostPort)) return; // malformed or duplicate
		await this.restartTransport();
	}

	/** Remove a bootstrap node and reconnect. */
	async removeBootstrap(hostPort: string): Promise<void> {
		if (!this.bootstrap.remove(hostPort)) return;
		await this.restartTransport();
	}

	/** Restore the built-in default bootstrap nodes and reconnect. */
	async resetBootstrap(): Promise<void> {
		this.bootstrap.reset();
		await this.restartTransport();
	}

	/** Tear down + rebuild the swarm transport (e.g. after a bootstrap change), same channel.
	 *  Farming is untouched — it runs off the shared node, not the transport. */
	private async restartTransport(): Promise<void> {
		if (!this.meshOn) return; // mesh off → nothing live to restart; the new list applies next start
		if (this.transport) await this.transport.destroy().catch(() => {});
		this.transport = undefined;
		await this.joinMesh();
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

		// 1. Tear down the current channel's consensus + storage. Stop the oracle loop and
		//    farming FIRST so neither posts a write into the store while it's closing.
		this.farming = false;
		this.oracleGen++; // the running oracle publisher loop exits on its next tick
		this.producer?.stop();
		this.producer = undefined;
		if (this.transport) await this.transport.destroy().catch(() => {});
		this.transport = undefined;
		if (this.store) await this.store.close().catch(() => {});
		this.store = undefined;
		this.anchorTimes.length = 0; // reset cadence samples for the new chain

		// 2. Fresh ledger + anchor chain — a clean economy for the new channel. The custody
		//    loop + accounts referenced the OLD node, so drop them; startConsensus rebuilds
		//    the rotation against the new node when farming.
		this.node = new GavlNode(new Ledger(this.params), new AnchorChain(this.params, this.verifier, { schedule: this.schedule, finalityDepth: this.finalityDepth, verifyState: (a, h) => this.checkAppRoot(a, h) }));
		this.rotation = undefined;
		this.equivWatcher = undefined;
		this.custodyAcct = undefined;
		// Reset checkpoint state — the new channel is a fresh economy with its own history.
		this.checkpointBase = undefined;
		this.lastCheckpointHeight = -1;
		this.viewCache = undefined;
		this.finalCache = undefined;
		this.wireTipCadence();
		this.accounts.clear();
		this.offers.clear(); // each channel is its own tape — drop the old channel's intents
		for (const wa of this.wallet.list()) this.bind(wa); // same identities, new node

		// 3. Switch to the new channel and bring it up (init store → replay → join + farm).
		//    Re-pass the oracle-publish config so this node re-publishes the price on the new
		//    chain (otherwise the new channel has no oracle.post writes → "no price" loads).
		this.network = next;
		await this.init();
		await this.startConsensus({ mesh: this.meshOn, farm: this.farmOn, publishOracle: this.oraclePublishOpts });
	}

	async stop(): Promise<void> {
		this.farming = false;
		this.producer?.stop();
		if (this.transport) await this.transport.destroy().catch(() => {});
		if (this.store) await this.store.close().catch(() => {});
		await this.params.vdf.close?.().catch(() => {}); // terminate the VDF worker pool, if any
	}
}

/** Filesystem-safe slug for a channel name (its store lives under channels/<slug>/). */
function channelSlug(name: string): string {
	const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
	return safe || "default";
}

/** A market channel's name IS its definition (and hashes to the DHT topic). Two QUORUM-SIGNED kinds
 *  — the price is signed by an M-of-N set and relayed by anyone; the fold verifies the quorum, never
 *  the relayer, and no single signer can forge:
 *    `label::pyth::<feedId>`     — a Wormhole-attested Pyth feed (13-of-19 guardian-set trust anchor).
 *    `label::signed::<setHash>`  — your own Ed25519 signer set, committed by `signerSetHash`.
 *  A name that doesn't match is a plain channel: no market, transfers only. */
export type ChannelMarket = { label: string } & MarketDef;
export function parseChannel(name: string): ChannelMarket | null {
	const parts = name.split("::");
	if (parts.length === 3 && parts[1].toLowerCase() === "pyth" && /^[0-9a-f]{64}$/i.test(parts[2])) {
		return { label: parts[0], kind: "pyth", feedId: parts[2].toLowerCase() };
	}
	if (parts.length === 3 && parts[1].toLowerCase() === "signed" && /^[0-9a-f]{64}$/i.test(parts[2])) {
		return { label: parts[0], kind: "signed", signerSet: parts[2].toLowerCase() };
	}
	return null;
}

/** Pyth BTC/USD feed id — the instrument the shipped default market prices. */
const BTC_USD_PYTH_FEED = "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

/** The default channel — the BTC-USD Pyth market: a Wormhole-attested price anyone relays, no
 *  reporter. This is the channel `npm run dev` joins, so the app prices + trades out of the box. */
export function defaultMarketChannel(): string {
	return `BTC-USD::pyth::${BTC_USD_PYTH_FEED}`;
}
