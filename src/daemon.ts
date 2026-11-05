/**
 * Daemon — the local engine behind the desktop app.
 *
 * Boots a single Ledger + GavlNode over the wallet's identities. With consensus wired (the
 * default), the node also carries an AnchorChain, the daemon joins the live Nostr mesh
 * (gossiping writes AND anchors over public relays), and runs a Producer that farms anchors over
 * the heaviest tip. The UI can then watch the real consensus advance: tip height/weight climbing,
 * finality deepening, peers joining.
 *
 * Gavl holds no funds: it is the ephemeral order board for BTC↔LTC atomic swaps, which settle on
 * their own chains via HTLCs. Every anchor commits (appRoot, lag-by-parent) to the order board its
 * parent certifies: market/fold.ts folds the certified writes, market/state.ts encodes the View.
 * One `Account` per wallet identity posts the order-board ops, all sharing the node and a single
 * monotonic clock (so op timestamps are causally ordered). The swap engine (swap/engine.ts, started
 * by server.ts) drives every local identity's matches on Bitcoin/Litecoin and posts its ops through
 * `submitOp`; the per-identity hot wallets behind /api/wallets and /api/send are the engine's.
 *
 * VDF is real chiavdf by default (genuine cooldown). The anchor space proof uses
 * the light stand-in by default so the node boots instantly without plotting —
 * the consensus mechanics (fork choice, finality, weight, gossip) are identical
 * either way; chiapos is opt-in via GAVL_SPACE=chiapos.
 */

import * as btc from "@scure/btc-signer";
import { Ledger, rootOfHeads } from "./ledger/ledger.ts";
import type { Heads } from "./ledger/ledger.ts";
import { GavlNode } from "./sync/node.ts";
import { emptyView, serializeView, deserializeView, viewRoot, cloneView } from "./market/state.ts";
import type { View, CanonOffer, CanonMatch } from "./market/state.ts";
import { viewAtAnchor, advance, applyOp } from "./market/fold.ts";
import { parseOp, opPayload, DEFAULT_OFFER_TTL, isChain, parseAmount } from "./market/ops.ts";
import type { Op } from "./market/ops.ts";
import { Account } from "./market/account.ts";
import { swapKey, swapSecretHash, takeSwapId, xOnly } from "./swap/keys.ts";
import { CHAINS, SwapEngine } from "./swap/engine.ts";
import type { EngineMode, SwapPolicy } from "./swap/engine.ts";
import { MAX_MONEY } from "./swap/proof.ts";
import { Esplora } from "./chains/esplora.ts";
import type { Chain, Net } from "./chains/esplora.ts";
import type { Anchor } from "./consensus/anchor.ts";
import { Wallet } from "./wallet.ts";
import type { WalletAccount } from "./wallet.ts";
import { defaultParams, swapPolicyFromEnv } from "./config.ts";
import type { ChainParams, Write } from "./chain/writer.ts";
import { AnchorChain, DEFAULT_FINALITY_DEPTH, DEFAULT_SETTLEMENT_DEPTH } from "./consensus/chain.ts";
import type { SettledConflict } from "./consensus/chain.ts";
import { genesisAnchor, GENESIS_PRODUCER } from "./consensus/genesis.ts";
import type { RetargetSchedule } from "./consensus/difficulty.ts";
import { Producer } from "./consensus/producer.ts";
import { StandinSpaceProver, StandinSpaceVerifier } from "./consensus/space.ts";
import type { SpaceVerifier, SpaceProver } from "./consensus/space.ts";
import { ChiaSpaceProver, ChiaSpaceVerifier, ensurePlot } from "./pos/chia.ts";
import { Plot } from "./pos/space.ts";
import { NostrTransport } from "./sync/nostr.ts";
import { KnownPeers } from "./sync/known-peers.ts";
import { generateKeyPair, keyPairFromSeed, sign } from "./det/ed25519.ts";
import type { KeyPair } from "./det/ed25519.ts";
import { toHex, fromHex } from "./det/canonical.ts";
import { WriteStore } from "./store/store.ts";
import type { StoredSnapshot } from "./store/store.ts";
import { KeepAllPolicy, MinePolicy } from "./store/policy.ts";
import type { PersistPolicy } from "./store/policy.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

export type SpaceMode = "standin" | "chiapos";

export interface DaemonOptions {
	walletDir?: string;
	params?: ChainParams;
	/** Plot-size exponent for each identity's PoST plot. */
	k?: number;
	/** Anchor-depth at which state is considered final (default DEFAULT_FINALITY_DEPTH). */
	finalityDepth?: number;
	/** Distinct peers that must offer the same checkpoint before a fresh node adopts it as a trusted
	 *  floor (genesis-free bootstrap). Default 1 (trust the first peer); set ≥2 for quorum so a lone
	 *  or sybil peer can't feed a fabricated history. See docs/weak-subjectivity.md. */
	adoptQuorum?: number;
	/** Desired number of DISTINCT nodes (including self) that durably hold the latest checkpoint —
	 *  the replication floor that keeps RAM state alive across churn. State survives the loss of up
	 *  to `replicationTarget - 1` holders between checkpoints. Default 1. See docs/replication-floor.md. */
	replicationTarget?: number;
	/** Anchor space backend: light stand-in (default) or real chiapos (real disk cost). */
	space?: SpaceMode;
	/** Initial channel/network name. Default "gavl". */
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
		dir?: string; // store dir (default ~/.gavl/store)
		/** "all" → archiver (keep everything); "mine" → only my wallet keys + their coins. */
		persist?: "all" | "mine";
		/** Or supply a custom policy directly (overrides `persist`). */
		policy?: PersistPolicy;
	};
	/** Swap engine wiring. Defaults: Esplora per chain from GAVL_{BTC,LTC}_NET / _ESPLORA_URL, policy
	 *  from config.ts swapPolicyFromEnv. The engine only ticks once `swaps.start()` is called. */
	swaps?: { explorers?: Record<Chain, Esplora>; policy?: SwapPolicy; tickMs?: number; mode?: EngineMode };
}

/** One hot wallet of the active identity, as GET /api/wallets reports it (amounts: base-unit decimals). */
export interface WalletInfo {
	chain: Chain;
	net: Net;
	address: string;
	confirmed: string;
	unconfirmed: string;
	/** Set when the explorer couldn't be reached (balances then read "0"). */
	error?: string;
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
	/** This node's network GENESIS id (deterministic block 0). The cross-machine identity check: two nodes
	 *  on the same network MUST show the same value; a different one means a different chain. Null pre-start. */
	genesis: string | null;
	/** Foreign genesises observed on peers — a peer on old code / a different network minted a different
	 *  block 0, so its anchors are rejected. Non-empty = an active split (surfaced so it isn't silent).
	 *  "∅" means a peer advertised no genesis at all (older code). */
	foreignGenesisSeen?: string[];
	finalizedHeight: number | null;
	/** Height of the SETTLED anchor (irreversible; checkpoints and pruning key off it). */
	settledHeight: number | null;
	/** Set when a peer's branch was REFUSED for abandoning this node's settled history — a split
	 *  deeper than settlement that needs an operator. Null while healthy. */
	settlementConflict: SettledConflict | null;
	/** Distinct ANCHOR PRODUCERS in the recent chain (NOT the op-writer count). */
	producers: number;
	/** Whether THIS node is currently producing anchors (its producer key signed a recent anchor). A
	 *  farming node that shows false is connected but not actually producing. */
	iProduce: boolean;
	/** How many of the recent anchors THIS node produced (a live "am I farming" counter). */
	myAnchors: number;
	/** Seconds per anchor used for time estimates — measured cadence if live, else the target rate. */
	secPerAnchor: number;
	/** True if secPerAnchor is a live measurement; false if it's the target fallback (cold/idle). */
	secPerAnchorMeasured: boolean;
	/** Wire carrier: "nostr" (public relays) | null (mesh off). */
	transport: string | null;
	/** Bounded-mesh diagnostics: connection cap and resolved producer↔address bindings. */
	maxPeers?: number;
	bindings?: number;
	/** This node's nostr pubkey (hex). Null if mesh off. */
	nodeKey: string | null;
	/** nostr pubkeys of currently-connected peers. */
	peerKeys: string[];
	/** nostr pubkeys pinned for re-dial on every boot (eclipse resistance). */
	pinnedPeers: string[];
}

/** How many finalized anchors between durable checkpoints. Small enough to bound growth,
 *  large enough that snapshotting/pruning isn't a per-anchor cost. Override for tests/tuning. */
const CHECKPOINT_EVERY = Number(process.env.GAVL_CHECKPOINT_EVERY ?? "16");

/** Anchors retained below a checkpoint. Generous enough to cover the retarget window (the only
 *  backward walk that reaches below the checkpoint); the daemon takes the max with it. Bounds the
 *  anchor chain to a constant suffix instead of forever. */
const ANCHOR_KEEP_MARGIN = Number(process.env.GAVL_ANCHOR_MARGIN ?? "256");

export class Daemon {
	node: GavlNode;
	readonly wallet: Wallet;
	/** Drives every local identity's matches through the on-chain swap (src/swap/engine.ts). */
	readonly swaps: SwapEngine;
	readonly knownPeers = new KnownPeers();
	readonly finalityDepth: number;
	private readonly adoptQuorum: number;
	private readonly replicationTarget: number;
	private readonly params: ChainParams;
	private readonly k: number;
	private readonly spaceMode: SpaceMode;
	private readonly plotDir: string;
	/** Root for node-local secrets (the producer key), beside the wallet — so a distinct walletDir
	 *  fully isolates a node (multiple nodes on one machine). */
	private readonly dataDir: string;

	private transport?: NostrTransport;
	private producer?: Producer;
	private network: string;
	private farming = false;
	private readonly heartbeatMs: number;
	private readonly targetSecPerAnchor: number;
	private store?: WriteStore;
	private readonly storeOpts?: DaemonOptions["store"];
	private producerKeyCache?: KeyPair;
	/** Kept so a channel switch can rebuild ledger/anchors/store identically. */
	private readonly verifier: SpaceVerifier;
	private readonly schedule?: RetargetSchedule;
	/** Whether the last startConsensus joined the mesh / farmed — replayed on switch. */
	private meshOn = false;
	private farmOn = false;
	/** Wall-clock arrival times (ms) of recent tip heights — for a measured anchor cadence.
	 *  Display-only (never touches the deterministic fold), so Date.now() is fine here. */
	private readonly anchorTimes: { height: number; at: number }[] = [];

	/** Recent network/diagnostic steps (seq'd ring buffer) for the app's Network activity log. Display-only
	 *  — never touches the deterministic fold, so Date.now() is fine here. */
	private readonly netEvents: { seq: number; ts: number; kind: string; text: string }[] = [];
	private netSeq = 0;

	constructor(opts: DaemonOptions = {}) {
		this.params = opts.params ?? defaultParams();
		this.k = opts.k ?? 11;
		this.finalityDepth = opts.finalityDepth ?? DEFAULT_FINALITY_DEPTH;
		this.adoptQuorum = opts.adoptQuorum ?? 1;
		this.replicationTarget = opts.replicationTarget ?? 1;
		// Idle anchor heartbeat. Server passes this from GAVL_HEARTBEAT_MS; for a directly-constructed
		// daemon (tests/embeds) honor the same env so it's tunable everywhere, keeping 120s as the default.
		this.heartbeatMs = opts.heartbeatMs ?? (Number(process.env.GAVL_HEARTBEAT_MS) || 120_000);
		this.targetSecPerAnchor = opts.targetSecPerAnchor ?? 60;
		this.spaceMode = opts.space ?? "standin";
		this.plotDir = opts.plotDir ?? join(homedir(), ".gavl", "plots");
		this.dataDir = opts.walletDir ?? join(homedir(), ".gavl");
		this.storeOpts = opts.store;
		this.schedule = opts.schedule;
		this.network = opts.network ?? "gavl";
		// Verifier must match the space backend producers use, or anchors are rejected.
		this.verifier = this.spaceMode === "chiapos" ? new ChiaSpaceVerifier() : new StandinSpaceVerifier();
		this.node = this.freshNode();
		this.wallet = new Wallet(opts.walletDir);
		this.wallet.ensureSeeded();
		const explorers = opts.swaps?.explorers ?? { bitcoin: Esplora.fromEnv("bitcoin"), litecoin: Esplora.fromEnv("litecoin") };
		this.swaps = new SwapEngine({
			host: {
				board: () => this.board(),
				channel: () => this.network,
				identities: () => this.wallet.list().map((a) => ({ pubHex: a.pubHex, seed: a.keypair.privateKey })),
				submitOp: (as, op) => this.submitOp(as, op),
				log: (text) => {
					console.log(`  swap: ${text}`);
					this.recordNetEvent("swap", text);
				},
			},
			explorers,
			dataDir: join(this.dataDir, "swaps"),
			policy: opts.swaps?.policy ?? swapPolicyFromEnv({ bitcoin: explorers.bitcoin.net, litecoin: explorers.litecoin.net }),
			tickMs: opts.swaps?.tickMs ?? (Number(process.env.GAVL_SWAP_TICK_MS) || undefined),
			mode: opts.swaps?.mode,
		});
		this.wireTipCadence();
	}

	/** A fresh ledger + anchor chain (boot and channel switch): soft finality at `finalityDepth`,
	 *  SETTLEMENT at DEFAULT_SETTLEMENT_DEPTH (irreversible; a deeper conflicting branch is refused
	 *  and reported, see settlementConflict), and the app-state check on every anchor. */
	private freshNode(): GavlNode {
		const chain = new AnchorChain(this.params, this.verifier, {
			schedule: this.schedule,
			finalityDepth: this.finalityDepth,
			settlementDepth: DEFAULT_SETTLEMENT_DEPTH,
			onSettledConflict: (c) => {
				console.error(`  ⚠ consensus: REFUSING a branch that abandons SETTLED anchor ${c.settled.id.slice(0, 8)} (height ${c.settled.height}) — tip ${c.rejected.id.slice(0, 8)} at height ${c.rejected.height}. The network has split deeper than settlement; this node stays on its settled history. Operator action needed.`);
				this.recordNetEvent("consensus", `refused branch abandoning settled height ${c.settled.height}`);
			},
			verifyState: (a) => this.checkAppRoot(a),
		});
		const node = new GavlNode(new Ledger(this.params), chain);
		node.mode = `${this.params.vdf.name}/${this.spaceMode}`; // hello advertises this → peers detect a proof-mode mismatch
		return node;
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
			this.maybeCheckpoint(); // snapshot + prune behind finality so history never grows unbounded
			this.tryPendingSnapshot(); // a stashed peer checkpoint may now be verifiable
			this.recordNetEvent("anchor", `tip → height ${tip.height}`);
			this.swaps.poke(); // the board moved: proofs, locks, aborts may be due
		};
		// surface applied writes to the Network feed (base hook; the store hook below chains this, so
		// it fires regardless of whether durable persistence is on).
		this.node.onApplied = (applied) => {
			if (applied.length) this.recordNetEvent("gossip", `applied ${applied.length} write${applied.length === 1 ? "" : "s"}`);
		};
		// checkpoint bootstrap — let a fresh peer load our latest state instead of all history.
		this.node.snapshotHeader = () => (this.lastSnapshot ? { anchorId: this.lastSnapshot.anchorId, height: this.lastSnapshot.height } : null);
		this.node.fullSnapshot = () => this.lastSnapshot ?? null;
		// A node bootstraps from state while it is still effectively fresh: no folded writers, OR a
		// genesis-only chain (every node installs hardcoded block 0 at boot, and gossiped writes can
		// land before the offer does — neither means we hold real history worth keeping).
		this.node.wantSnapshot = (offer) =>
			(this.node.ledger.summary().writers === 0 || (this.node.anchors?.tip()?.height ?? 0) === 0) && offer.height > this.lastCheckpointHeight;
		this.node.onSnapshot = (snap) => this.ingestSnapshot(snap);
		this.node.adoptFloor = (candidates) => this.adoptFloor(candidates);
		this.node.snapshotQuorum = this.adoptQuorum; // distinct peers required to adopt a checkpoint
		// replication floor — keep RAM state alive across churn by ensuring enough nodes hold the
		// latest checkpoint. Warn when under target so an operator can bring up more archivers.
		this.node.replicationTarget = this.replicationTarget;
		this.node.onUnderReplicated = (i) => {
			console.warn(`  ⚠ checkpoint ${i.anchorId.slice(0, 8)} (height ${i.height}) held by only ${i.factor}/${i.target} node(s) — bring up more archivers (GAVL_PERSIST=all) to keep state durable`);
			this.recordNetEvent("replication", `checkpoint ${i.anchorId.slice(0, 8)} held by only ${i.factor}/${i.target} node(s)`);
		};
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
		let state: View;
		try {
			state = deserializeView(snap.state);
		} catch {
			return false; // not this app's canonical state shape
		}
		if (viewRoot(state) !== child.appRoot) return false; // state doesn't match the committed appRoot → reject
		// Authentic. Seed the ledger at the checkpoint and fold forward from its state.
		this.node.ledger.seedCheckpoint(snap.heads);
		this.setCheckpointBase(state);
		this.lastCheckpointHeight = snap.height;
		this.lastSnapshot = snap;
		this.pendingSnapshot = undefined;
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
		if (!anchors || !snap || (anchors.tip() !== null && anchors.tip()!.height !== 0)) return false; // only on a fresh (or genesis-only) chain, with a pulled checkpoint
		const floor = candidates.find((a) => a.id === snap.anchorId);
		if (!floor) return false; // the checkpoint's anchor isn't in this suffix (yet)
		if (!this.node.snapshotQuorumMet(snap.anchorId)) return false; // not enough distinct peers vouch for this floor
		if (rootOfHeads(snap.heads) !== floor.stateRoot) return false; // snapshot heads must be the ones the floor PoST-committed
		// Gather the hash-linked run directly below the floor from the same suffix (peers serve a
		// margin below their checkpoint for exactly this) — it lets recompute windows that dip below
		// the floor draw the real anchors instead of truncating (required when window > epoch).
		const byId = new Map(candidates.map((a) => [a.id, a]));
		const ancestry: Anchor[] = [];
		for (let cur = floor; cur.prev && byId.has(cur.prev); ) {
			const below = byId.get(cur.prev)!;
			ancestry.push(below);
			cur = below;
		}
		try {
			anchors.adopt(floor, snap.heads, ancestry); // install the trusted root (throws if unsafe — e.g. off an epoch boundary)
		} catch (e) {
			if (process.env.GAVL_SYNC_DEBUG) console.error(`  sync-debug: adoptFloor failed at h=${floor.height}: ${e instanceof Error ? e.message : e}`);
			return false;
		}
		return true; // ingestSnapshot (on the next tip) authenticates + seeds the state above this floor
	}

	/** Retry a stashed snapshot once the anchor chain has caught up (called on each tip move).
	 *  On success, re-advertise so peers serve the post-checkpoint write tail. */
	private tryPendingSnapshot(): void {
		if (this.pendingSnapshot && this.ingestSnapshot(this.pendingSnapshot)) this.node.advertise();
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
		// ledger state), so its persisted writes live under channels/<slug>/. The wallet
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
			this.setCheckpointBase(deserializeView(snap.state)); // throws on a state that isn't this app's canonical shape
			this.node.ledger.seedCheckpoint(snap.heads);
			this.lastCheckpointHeight = snap.height;
			this.lastSnapshot = snap; // serve it to fresh peers too
			console.log(`  storage: loaded checkpoint at height ${snap.height} (${Object.keys(snap.heads).length} writer head(s)) — skipping replay below it`);
		}

		// Replay persisted writes into the ledger BEFORE going live. Seed the logical clock past the
		// highest replayed ts so new writes are GLOBALLY monotonic — otherwise a restart resets ts to
		// 0, colliding with persisted writes in the intra-epoch (ts) fold order.
		const { writes } = await this.store.replay((w) => {
			// skipTimeProof: these writes already passed full verification (VDF included) before they
			// were persisted, so re-walking each O(iters) cooldown here would block boot for minutes on
			// a large backlog. The cheap sig/id/structure checks still run, catching disk corruption.
			this.node.ledger.apply(w, { skipTimeProof: true });
			if (w.ts > this.clock) this.clock = w.ts;
		});

		// Persist every newly-applied write (write-through, policy-filtered). Guarded against
		// a store that's being torn down mid-flight (a channel switch closes it) — a late
		// write must NOT crash the daemon with an unhandled "database is closed" rejection.
		const prev = this.node.onApplied;
		this.node.onApplied = (applied) => {
			prev?.(applied); // chain the base hook (records the gossip event)
			const store = this.store;
			if (!store) return;
			for (const w of applied) void store.persist(w).catch(() => {});
		};
		return { replayed: writes };
	}

	/** Record a network/diagnostic step for the app's Network activity log. */
	recordNetEvent(kind: string, text: string): void {
		this.netEvents.push({ seq: ++this.netSeq, ts: Date.now(), kind, text });
		if (this.netEvents.length > 500) this.netEvents.shift();
	}

	/** Network events newer than the `since` seq cursor, plus the current cursor. */
	events(since: number): { events: { seq: number; ts: number; kind: string; text: string }[]; cursor: number } {
		return { events: this.netEvents.filter((e) => e.seq > since), cursor: this.netSeq };
	}

	storeStats() {
		return this.store?.stats() ?? null;
	}

	/** Create a new wallet identity and make it active. */
	createAccount(label: string): WalletAccount {
		return this.wallet.create(label);
	}

	// ── accounts: one write-producing Account per wallet identity ──────
	private readonly accounts = new Map<string, Account>();
	/** Logical clock for write `ts` — monotonic across every account (seeded past replayed writes). */
	private clock = 0;
	private readonly now = (): number => ++this.clock;

	/** The write-producing Account for a wallet identity (bound to the current node). */
	account(pubHex: string): Account {
		const existing = this.accounts.get(pubHex);
		if (existing) return existing;
		const wa = this.wallet.get(pubHex);
		if (!wa) throw new Error(`daemon: unknown account ${pubHex}`);
		const acct = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: wa.keypair });
		this.accounts.set(pubHex, acct);
		return acct;
	}

	// ── committed app state + state-committed checkpoints — the ledger never replays from 0 ──
	/** The order board at the ledger's prune floor (the last checkpoint). The ledger holds only writes
	 *  ABOVE it; every fold resumes from here. Undefined ⇒ full history (never checkpointed). */
	private checkpointBase?: View;
	private lastCheckpointHeight = -1;
	/** The latest durable checkpoint (kept in memory so it can be served to fresh peers). */
	private lastSnapshot?: StoredSnapshot;
	/** A peer's checkpoint awaiting anchor-chain sync before it can be authenticated. */
	private pendingSnapshot?: StoredSnapshot;
	/** viewRoot of the empty board — what genesis (and any anchor on a parentless chain) commits. */
	private readonly emptyAppRoot = viewRoot(emptyView());
	/** Memoized fold per anchor id. A pure function of the anchor (its certified writes are immutable
	 *  once it's in-chain) and the checkpoint base, so it is dropped whenever the base moves. Bounded:
	 *  only recent anchors are ever asked for (tip, its parent, inbound anchors' parents). */
	private readonly viewCache = new Map<string, View>();

	/** Rebase every fold onto `base` (a checkpoint's committed state). */
	private setCheckpointBase(base: View | undefined): void {
		this.checkpointBase = base;
		this.viewCache.clear();
	}

	/** The order board anchor `anchorId` certifies, folded from the checkpoint base. Read-only:
	 *  callers must clone before mutating. Memoized only once the ledger holds every write the anchor
	 *  certifies — a fold over a partial write set (still syncing) is never cached as the anchor's. */
	private viewAt(anchorId: string): View {
		const cached = this.viewCache.get(anchorId);
		if (cached) return cached;
		const anchors = this.node.anchors!;
		const v = viewAtAnchor(this.node.ledger.allWrites(), anchors, anchorId, this.checkpointBase);
		if (this.haveAllWrites(anchors.headsAt(anchorId))) {
			if (this.viewCache.size >= 64) this.viewCache.delete(this.viewCache.keys().next().value!); // oldest first
			this.viewCache.set(anchorId, v);
		}
		return v;
	}

	/** The appRoot an anchor extending `prev` must commit: viewRoot of the board `prev` certifies
	 *  (lag-by-parent → always computable from an in-chain anchor); empty at genesis. */
	private appRootFor(prev: Anchor | null): string {
		if (!prev || !this.node.anchors) return this.emptyAppRoot;
		return viewRoot(this.viewAt(prev.id));
	}

	/** AnchorChain.verifyState hook — enforce a peer's appRoot against our own fold. If we lack the
	 *  parent's certified writes we DEFER (can't judge yet; it would be re-checked on arrival). */
	private checkAppRoot(anchor: Anchor): boolean {
		const anchors = this.node.anchors;
		if (!anchors) return true;
		const prev = anchor.prev ? (anchors.get(anchor.prev) ?? null) : null;
		if (!prev) return anchor.appRoot === this.emptyAppRoot;
		if (!this.haveAllWrites(anchors.headsAt(prev.id))) return true; // missing data → defer, don't reject
		return anchor.appRoot === this.appRootFor(prev);
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
		// Checkpoint (and prune history below it) only behind SETTLEMENT: pruning is irreversible, and a
		// soft-final anchor can still be reverted by fork resolution.
		const fin = anchors.settled();
		if (!fin) return;
		// Checkpoint at a DETERMINISTIC height — the largest CHECKPOINT_EVERY boundary the settled
		// anchor has crossed — not at each node's current tip. So every honest node
		// checkpoints the SAME anchor, and a bootstrapping node can collect a quorum of identical
		// offers (see docs/weak-subjectivity.md). Local-only; checkpoints aren't committed in any root.
		const target = Math.floor(fin.height / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
		if (target <= 0 || target <= this.lastCheckpointHeight) return;
		let ckpt: Anchor | undefined = fin;
		while (ckpt && ckpt.height > target) ckpt = ckpt.prev ? anchors.get(ckpt.prev) : undefined;
		if (!ckpt || ckpt.height !== target) return; // the boundary anchor isn't reachable yet → wait
		const heads = anchors.headsAt(ckpt.id);
		if (Object.keys(heads).length === 0) return; // nothing certified yet
		if (!this.haveAllWrites(heads)) return; // can't fold the boundary state yet → wait for the writes
		const view = this.viewAt(ckpt.id); // the committed board at the boundary
		this.lastCheckpointHeight = ckpt.height;
		const snap: StoredSnapshot = { anchorId: ckpt.id, height: ckpt.height, heads, state: serializeView(view) };
		this.lastSnapshot = snap; // kept in RAM to serve fresh peers (key-only nodes included)
		this.node.reBeaconHave(); // advertise we hold the new checkpoint; count toward the replication floor
		this.node.checkReplication(); // warn if too few nodes hold it
		this.recordNetEvent("checkpoint", `committed @ height ${ckpt.height} (${Object.keys(heads).length} writer head${Object.keys(heads).length === 1 ? "" : "s"})`);
		const before = this.node.ledger.summary().writes;
		this.node.ledger.pruneBelow(heads); // drop RAM history below the checkpoint — bounds memory
		this.setCheckpointBase(view); // every later fold resumes from the boundary state
		// Bound the anchor chain too (local memory only — not committed in any root). Keep a
		// suffix below the checkpoint that still covers the retarget window, so every backward
		// walk (difficulty, finality, heads) stays intact.
		const anchorsBefore = anchors.size;
		const margin = Math.max(ANCHOR_KEEP_MARGIN, this.schedule?.window ?? 0);
		anchors.prune(ckpt.height - margin); // keep a margin below the CHECKPOINT (not the tip) so it stays serveable
		// Durable store, if any: persist the snapshot + reclaim the pruned blocks (best-effort).
		const store = this.store;
		const persisted = store ? " (persisting)" : " (RAM-only)";
		if (store) void store.persistSnapshot(snap).then(() => store.pruneBelow(heads)).catch(() => {});
		console.log(`  checkpoint: height ${ckpt.height} (boundary), ${Object.keys(heads).length} writer(s); pruned ${before - this.node.ledger.summary().writes} write(s) + ${anchorsBefore - anchors.size} anchor(s) from RAM${persisted}`);
	}

	// ── order board ──────────────────────────────────────────────────

	/** The order board the current tip anchor certifies (the freshest consensus-ordered state; the
	 *  tip's child will commit to it). Pre-consensus: the checkpoint base, or empty. Read-only. */
	board(): { height: number | null; view: View } {
		const tip = this.node.anchors?.tip() ?? null;
		if (!tip) return { height: null, view: this.checkpointBase ?? emptyView() };
		return { height: tip.height, view: this.viewAt(tip.id) };
	}

	/** Listed offers (JSON-safe), id-sorted. */
	offers(): { height: number | null; offers: CanonOffer[] } {
		const { height, view } = this.board();
		return { height, offers: serializeView(view).offers };
	}

	/** Matches (JSON-safe), id-sorted; `mine` keeps those where a wallet identity is maker or taker. */
	matches(mine: boolean): { height: number | null; matches: CanonMatch[] } {
		const { height, view } = this.board();
		const keys = new Set(this.wallet.list().map((a) => a.pubHex));
		return { height, matches: serializeView(view).matches.filter((m) => !mine || keys.has(m.maker) || keys.has(m.taker)) };
	}

	/**
	 * Post an order-board op from local identity `as` (default: the ACTIVE one). `build` gets the exact
	 * seq the write will take (a taker's swap id depends on it). Before paying the write's cooldown the
	 * op is parsed and dry-run through the fold against the tip's board at the next height, so a
	 * malformed or already-invalid op throws here instead of landing as a no-op. The fold stays the
	 * authority: the op can still be rejected if the board changes before it is certified.
	 */
	private submit(build: (seq: number, seed: Uint8Array) => Record<string, unknown>, as?: string): Promise<Write> {
		const wa = as === undefined ? this.wallet.active() : this.wallet.get(as);
		if (!wa) throw new Error(`daemon: unknown account ${as}`);
		const acct = this.account(wa.pubHex);
		return acct.post((seq: number) => {
			const payload = build(seq, wa.keypair.privateKey);
			const op = parseOp(payload);
			if (!op) throw new Error(`malformed ${String(payload.kind)} op`);
			const { height, view } = this.board();
			const h = (height ?? 0) + 1;
			const dry = cloneView(view);
			advance(dry, h);
			const reason = applyOp(dry, { id: "", writer: acct.pubHex, seq }, op, h);
			if (reason) throw new Error(`${op.kind} rejected: ${reason}`);
			return opPayload(op);
		});
	}

	/** List an offer: give `give.amount` on `give.chain` for `want.amount` on `want.chain` (base units,
	 *  decimal strings), in fills of ≥ minFill give-units, listed for `expiresIn` anchors. */
	async postOffer(args: { give: { chain: string; amount: string }; want: { chain: string; amount: string }; minFill: string; expiresIn?: number }): Promise<{ offerId: string }> {
		const w = await this.submit(() => ({
			kind: "offer.post",
			give: { chain: args.give?.chain, amount: args.give?.amount },
			want: { chain: args.want?.chain, amount: args.want?.amount },
			minFill: args.minFill,
			expiresIn: args.expiresIn ?? DEFAULT_OFFER_TTL,
		}));
		return { offerId: w.id };
	}

	/** Cancel one of the active identity's offers (open matches keep their reserved fill). */
	async cancelOffer(offerId: string): Promise<{ writeId: string }> {
		const w = await this.submit(() => ({ kind: "offer.cancel", offerId }));
		return { writeId: w.id };
	}

	/** Take `fill` give-units of an offer as the swap INITIATOR. The secret hash and the taker's swap
	 *  key are derived from the wallet seed and the take's position (swap/keys.ts takeSwapId), so the
	 *  daemon can re-derive them from the match record (offerId, taker, takeSeq) at any time. */
	async takeOffer(offerId: string, fill: string): Promise<{ matchId: string; hash: string; takerKey: string }> {
		const offer = this.board().view.offers.get(offerId);
		if (!offer) throw new Error("offer.take rejected: no such offer");
		const taker = this.wallet.active().pubHex;
		let derived = { hash: "", takerKey: "" };
		const w = await this.submit((seq, seed) => {
			const swapId = takeSwapId(offerId, taker, seq);
			derived = { hash: toHex(swapSecretHash(seed, swapId)), takerKey: toHex(xOnly(swapKey(seed, swapId, offer.want.chain, "taker"))) };
			return { kind: "offer.take", offerId, fill, ...derived };
		});
		return { matchId: w.id, ...derived };
	}

	/** Post `op` as local identity `as` — the swap engine's path onto the board (swap.proof /
	 *  swap.locked / swap.abort for whichever local identity is the party). */
	async submitOp(as: string, op: Op): Promise<{ writeId: string }> {
		const w = await this.submit(() => opPayload(op), as);
		return { writeId: w.id };
	}

	/** The active identity's hot wallet on each chain (address + balance from the explorer). */
	async wallets(): Promise<{ wallets: WalletInfo[] }> {
		const pub = this.wallet.active().pubHex;
		const wallets = await Promise.all(
			CHAINS.map(async (chain): Promise<WalletInfo> => {
				const w = this.swaps.wallet(pub, chain);
				const base = { chain, net: w.net, address: w.address() };
				try {
					const b = await w.balance();
					return { ...base, confirmed: b.confirmed.toString(), unconfirmed: b.unconfirmed.toString() };
				} catch (e) {
					return { ...base, confirmed: "0", unconfirmed: "0", error: (e as Error).message };
				}
			}),
		);
		return { wallets };
	}

	/** Withdraw from the active identity's hot wallet: `amount` base units to `to` at `feeRate` sat/vB
	 *  (default: the swap policy's rate for the chain). */
	async send(args: { chain: unknown; to: unknown; amount: unknown; feeRate?: unknown }): Promise<{ txid: string }> {
		if (!isChain(args.chain)) throw new Error("send: chain must be bitcoin | litecoin");
		if (typeof args.to !== "string" || args.to.length === 0) throw new Error("send: `to` address required");
		const amount = parseAmount(args.amount, MAX_MONEY[args.chain]);
		if (amount === null) throw new Error("send: amount must be a positive base-unit decimal string");
		const feeRate = args.feeRate === undefined || args.feeRate === null ? this.swaps.policy.feeRate[args.chain] : Number(args.feeRate);
		const wallet = this.swaps.wallet(this.wallet.active().pubHex, args.chain);
		const to = args.to.trim();
		try {
			btc.Address(wallet.network.btc).decode(to);
		} catch {
			throw new Error(`send: ${to} is not a ${args.chain} ${wallet.net} address`);
		}
		const pay = await wallet.send({ to, amount, feeRate });
		return { txid: pay.txid };
	}

	consensus(): ConsensusStatus {
		const tip = this.node.anchorTip();
		const finalized = this.node.anchors?.finalized(this.finalityDepth) ?? null;
		const measured = this.measuredSecPerAnchor();
		// Distinct anchor PRODUCERS in the recent (pruned) chain, vs the op-writer count. Also whether
		// THIS node is among them (it's actually producing, not just connected).
		const recent = this.node.anchors?.chainTo(tip) ?? [];
		const myId = this.producerId();
		// Exclude the hardcoded-genesis sentinel — it's the chain root, not a farmer, so it must not
		// inflate the producer count (a solo node would otherwise read as 2 producers: itself + genesis).
		const producerSet = new Set(recent.map((a) => a.producer).filter((p) => p !== GENESIS_PRODUCER));
		return {
			enabled: !!this.node.anchors,
			vdf: this.params.vdf.name,
			space: this.spaceMode,
			mesh: !!this.transport,
			network: this.network,
			peers: this.node.peerCount,
			farming: this.farming,
			tip: tip ? { height: tip.height, weight: tip.weight, id: tip.id } : null,
			genesis: this.node.genesisId ?? null,
			foreignGenesisSeen: this.node.warnedGenesis.size ? [...this.node.warnedGenesis] : undefined,
			finalizedHeight: finalized ? finalized.height : null,
			settledHeight: this.node.anchors?.settled()?.height ?? null,
			settlementConflict: this.node.anchors?.settledConflict ?? null,
			producers: producerSet.size,
			iProduce: producerSet.has(myId),
			myAnchors: recent.reduce((n, a) => n + (a.producer === myId ? 1 : 0), 0),
			secPerAnchor: measured ?? this.targetSecPerAnchor,
			secPerAnchorMeasured: measured != null,
			transport: this.transport ? "nostr" : null,
			nodeKey: this.transport ? this.transport.nodeKeyHex : null,
			peerKeys: this.transport ? this.transport.connectedPeerKeys() : [],
			pinnedPeers: this.knownPeers.list(),
			// bounded-mesh + binding diagnostics
			...(this.transport?.diagnostics?.() ?? {}),
		};
	}

	/** Build the swarm transport, join the current channel's topic, re-dial pinned peers.
	 *  Resilient to a slow/absent DHT (soft 8s cap) — falls back to local if it fails. */
	private async joinMesh(): Promise<void> {
		try {
			// Gossip rides NOSTR: ephemeral events over public relays. No local daemon, no sidecar, no
			// NAT concerns — the node only makes OUTBOUND connections. Discovery is a relay query
			// (presence events), so there are no seeds and no PEX; relays are untrusted, plural and
			// individually unreliable, so we publish to all of them and treat each as disposable.
			this.transport = new NostrTransport(this.node, {
				network: this.network,
				storageDir: join(this.dataDir, "nostr"),
				maxPeers: process.env.GAVL_MAX_PEERS ? Number(process.env.GAVL_MAX_PEERS) : undefined,
				onEvent: (kind, text) => this.recordNetEvent(kind, text), // surface peer/binding steps to the UI feed
				// sign producer↔address binding so peers can address us by our consensus key
				bindingSigner: (msg) => ({ producer: this.producerId(), sig: toHex(sign(this.producerKey().privateKey, msg)) }),
			});
			await this.transport.join(this.network); // resolves once our identity + subscriptions are live
			// Re-dial pinned peers directly (independent of PEX discovery) — eclipse resistance.
			for (const key of this.knownPeers.list()) {
				try {
					this.transport.dialPeer(key);
				} catch {
					/* skip a malformed pin */
				}
			}
		} catch (e) {
			// Gavl networks ONLY over Nostr — never silently degrade to a mesh-less "local" node.
			console.error(`\n✗ Nostr mesh failed to start: ${(e as Error).message}`);
			console.error("  Gavl needs to reach at least one public Nostr relay (outbound WSS).");
			console.error("  Check connectivity, or pick your own relays with GAVL_RELAYS=wss://a,wss://b");
			process.exit(1);
		}
	}

	/** Join the live mesh and (optionally) start farming anchors. Resilient to a missing network. */
	async startConsensus(opts: { network?: string; mesh: boolean; farm: boolean }): Promise<void> {
		if (opts.network) this.network = opts.network;
		this.meshOn = opts.mesh;
		this.farmOn = opts.farm;
		this.node.genesisId = this.genesisFor().id; // advertise our network's block 0 in hello, BEFORE joinMesh greets peers

		if (opts.mesh) await this.joinMesh();
		await this.bootstrapChainRoot(); // JOIN the heaviest existing network (adopt its checkpoint) if there is one, else SEED the deterministic genesis

		if (opts.farm) {
			// Stable producer identity (persisted) so this node farms under the SAME key across reboots.
			const farmer = this.producerKey();
			let prover: SpaceProver;
			if (this.spaceMode === "chiapos") {
				// Real disk cost: plot the farmer's chiapos plot (slow the first time, then cached).
				const pub = toHex(farmer.publicKey);
				const plotPath = ensurePlot(pub, this.k, this.plotDir);
				prover = new ChiaSpaceProver({ pubHex: pub, k: this.k, plotPath });
			} else {
				prover = new StandinSpaceProver(new Plot(farmer.publicKey, this.k));
			}
			this.producer = new Producer({ node: this.node, keypair: farmer, prover, params: this.params, appRootFor: (prev) => this.appRootFor(prev) });
			this.farming = true;
			this.startHealthWatch(); // warn if we farm but never produce an anchor
			this.startFarming();
		}
	}

	/**
	 * Root the chain at startup, honoring "follow the heaviest PoST chain": JOIN an existing network if one
	 * is reachable, else SEED. A MATURE network's peers offer a finalized CHECKPOINT — adopt it (weak
	 * subjectivity: trust the heaviest chain the network already agreed on) via the node.adoptFloor hook,
	 * which fires when a quorum-vouched snapshot + its anchor suffix arrive. We give that a grace window but
	 * don't stall a COLD-START / young network (no checkpoint to offer): once the discovery sweep finishes
	 * with nothing inbound, fall through to the deterministic genesis. Because every node derives the SAME
	 * block 0, a young network's peers (same genesis) then sync straight onto it, and a brand-new network is
	 * seeded race-free. Mesh-off → seed at once. The genesis is just the bootstrap seed for when there's
	 * nothing to join — it gets pruned away once the chain matures into checkpoints. Tunable: GAVL_BOOTSTRAP_ADOPT_MS.
	 */
	private async bootstrapChainRoot(): Promise<void> {
		const anchors = this.node.anchors;
		if (!anchors || anchors.tip()) return; // already rooted (e.g. a reused chain)
		if (this.transport) {
			this.node.resync(); // solicit chains + snapshot offers from peers
			const graceMs = Number(process.env.GAVL_BOOTSTRAP_ADOPT_MS ?? 8000);
			const started = Date.now();
			const deadline = started + graceMs;
			while (Date.now() < deadline && !anchors.tip()) {
				// Wait while a checkpoint could still land: one is being pulled (pendingSnapshot), or we're
				// still inside the discovery window. Discovery spans the whole grace period — the
				// first anchor-tip (which triggers a fresh node's snapshot-want) can take tens of seconds
				// to arrive (tunnel build + leaseset lookup), so bailing at a few seconds guarantees a genesis restart that islands the node.
				const checkpointInflight = this.pendingSnapshot != null;
				const stillDiscovering = Date.now() - started < graceMs;
				if (!checkpointInflight && !stillDiscovering) break;
				await new Promise((r) => setTimeout(r, 400));
			}
			if (anchors.tip()) {
				console.log(`  consensus: adopted a checkpoint (height ${anchors.tip()!.height}) — joined the existing heaviest network`);
				return;
			}
			// Rooting at genesis on a mesh: a checkpoint loaded from our own disk can't be on this chain.
			const discarded = await this.discardOffChainCheckpoint();
			this.installGenesisRoot();
			if (discarded) this.node.resync(); // re-pull peers' chains + writes now that block 0 is in place
			return;
		}
		this.installGenesisRoot(); // nothing to join → seed the deterministic genesis
	}

	/**
	 * A checkpoint loaded from this node's own disk only means something on the chain it was cut from.
	 * Anchors aren't persisted, so when no peer re-offers that chain and the node roots at the hardcoded
	 * genesis instead, the stored checkpoint — and the writes replayed on top of it — belong to a chain
	 * this node is no longer on. Folding them in makes every appRoot here differ from any peer that
	 * doesn't hold the identical stale base: each side rejects the other's block 1 ("appRoot ≠ folded
	 * state") and farms a private fork forever. So drop that channel state (RAM + disk) and start the
	 * genesis chain from the same empty base as everyone else; anything still live re-syncs from peers.
	 * Mesh-only: a lone node has nobody to disagree with and keeps its state across restarts.
	 * Returns true if state was discarded.
	 */
	private async discardOffChainCheckpoint(): Promise<boolean> {
		if (this.lastCheckpointHeight < 0) return false;
		const writes = this.node.ledger.summary().writes;
		console.warn(`  storage: saved checkpoint (height ${this.lastCheckpointHeight}) isn't on the chain this node is joining — discarding it and ${writes} stale write(s), starting from genesis`);
		this.node.ledger.reset();
		this.lastCheckpointHeight = -1;
		this.lastSnapshot = undefined;
		this.setCheckpointBase(undefined);
		await this.store?.clear();
		return true;
	}

	/** The DETERMINISTIC genesis for this node's network — a pure function of the network label and base
	 *  difficulty (consensus/genesis.ts). Identical on every node on the same network whether it seeds this
	 *  as its root or adopts a later checkpoint, so its id is the stable value advertised for
	 *  genesis-mismatch detection (a peer with a different block 0 is on another network). */
	private genesisFor(): Anchor {
		const difficulty = this.schedule?.base ?? this.params.difficulty; // genesis difficulty = schedule base
		return genesisAnchor({ network: this.network, difficulty, appRoot: this.emptyAppRoot });
	}

	/**
	 * Install the hardcoded genesis as block 0 (consensus/genesis.ts). Every node derives the SAME anchor
	 * from the network + base difficulty and installs it as the locked root — no seeder election, no
	 * minting, no race. Idempotent and only acts on a fresh chain: a node that already adopted a checkpoint
	 * floor or synced a tip keeps it. Called by bootstrapChainRoot only when there is no network to join, so
	 * the chain always has its root before a height-1 anchor (local or gossiped) needs to link to it.
	 */
	private installGenesisRoot(): void {
		const anchors = this.node.anchors;
		if (!anchors || anchors.tip()) return; // already rooted (checkpoint-adopt or a prior install) — leave it
		anchors.installGenesis(this.genesisFor());
	}

	/** Run the producer from the current tip. Adaptive: farm hard while there are unfinalized writes to
	 *  bury, then drop to a slow heartbeat when idle — work tracks activity. busyPaceMs keeps the event
	 *  loop (HTTP, gossip) responsive. */
	private startFarming(): void {
		const tip = this.node.anchorTip();
		console.log(`  consensus: farming from block ${tip?.height ?? 0} on hardcoded genesis ${tip ? tip.id.slice(0, 8) + "…" : "?"}`);
		void this.producer!.runAdaptive({
			until: () => !this.farming,
			finalityDepth: this.finalityDepth,
			busyPaceMs: 250,
			// While peers are connected, never mint faster than the mesh gossips a height: competing
			// farmers that outrun gossip each build a private run that fork-choice orphans wholesale (the
			// 3-node real-PoST `producers`-collapse — see producer.runAdaptive). 8s leaves margin over relay
			// latency; raise GAVL_PEER_PACE_MS if a slower mesh still diverges.
			peerPaceMs: Number(process.env.GAVL_PEER_PACE_MS ?? 8000),
			heartbeatMs: this.heartbeatMs,
			hasPeers: () => this.node.peerCount > 0,
		});
	}

	/** DIAGNOSTIC (3): a node that's farming but never produces an anchor (a small plot, a stalled VDF
	 *  worker, or a forgotten venv) silently adds no weight. Warn once after a grace period. */
	private startHealthWatch(): void {
		if (this.healthTimer) return;
		this.farmingStart = Date.now();
		this.warnedNoProduce = false;
		this.healthTimer = setInterval(() => {
			if (!this.farming) return;
			const c = this.consensus();
			const upMin = (Date.now() - this.farmingStart) / 60000;
			if (c.myAnchors === 0 && upMin > 5 && !this.warnedNoProduce) {
				this.warnedNoProduce = true;
				console.warn(`  ⚠ health: farming for ${upMin.toFixed(0)}m on ${c.vdf}/${c.space} but produced 0 anchors. Real PoST: a small plot rarely wins — raise GAVL_K or give it time. If you have peers (${c.peers}) but the tip is frozen, check they run the SAME proof mode.`);
			}
			if (c.myAnchors > 0) this.warnedNoProduce = false; // produced again → re-arm for a later stall
		}, 60_000);
	}

	private stopHealthWatch(): void {
		if (this.healthTimer) clearInterval(this.healthTimer);
		this.healthTimer = undefined;
	}

	/** This node's STABLE anchor-producer key (persisted), pinned to disk like the wallet seed so the
	 *  node farms under the same identity across restarts. */
	private producerKeyPath(): string {
		return join(this.dataDir, "farmer.json");
	}
	private producerKey(): KeyPair {
		if (this.producerKeyCache) return this.producerKeyCache;
		const path = this.producerKeyPath();
		if (existsSync(path)) {
			this.producerKeyCache = keyPairFromSeed(fromHex(JSON.parse(readFileSync(path, "utf8")).seed));
		} else {
			const kp = generateKeyPair();
			mkdirSync(this.dataDir, { recursive: true });
			writeFileSync(path, JSON.stringify({ seed: toHex(kp.privateKey) }), { mode: 0o600 }); // privateKey IS the 32-byte seed
			this.producerKeyCache = kp;
		}
		return this.producerKeyCache;
	}

	/** This node's producer id (stable producer pubkey hex). */
	producerId(): string {
		return toHex(this.producerKey().publicKey);
	}

	/** DIAGNOSTIC (3): farming-health watchdog — warns when a node farms but never produces an anchor. */
	private healthTimer?: ReturnType<typeof setInterval>;
	private farmingStart = 0;
	private warnedNoProduce = false;

	/** The channel/network this node is currently on. */
	currentChannel(): string {
		return this.network;
	}

	// ── identity control ─────────────────────────────────────────────

	/** Reroll: create a fresh identity and make it active. Returns its pubkey. */
	rerollIdentity(label?: string): string {
		const acct = this.wallet.create(label || `identity ${this.wallet.list().length + 1}`);
		return acct.pubHex;
	}

	/** Import an identity from a 32-byte seed (hex), make it active. Returns its pubkey. */
	importIdentity(seedHex: string, label?: string): string {
		const acct = this.wallet.importSeed(seedHex, label);
		return acct.pubHex;
	}

	/** Export the active identity's seed (private key, hex). Handle with care. */
	exportActiveSeed(): string {
		return this.wallet.exportSeed(this.wallet.active().pubHex);
	}

	// ── peer control ─────────────────────────────────────────────────

	/** Pin a peer by its nostr pubkey (hex); if `pin`, also persist it for re-dial on every boot. */
	dialPeer(peerAddr: string, pin = true): void {
		const addr = peerAddr.trim().toLowerCase();
		if (pin) this.knownPeers.add(addr);
		this.transport?.dialPeer(addr); // no-op if mesh is off; the pin still applies next boot
	}

	/** Unpin a known peer (stops re-dialing it on boot; doesn't drop a live connection). */
	unpinPeer(nodeKeyHex: string): boolean {
		return this.knownPeers.remove(nodeKeyHex);
	}

	/** Pinned peer node-keys (re-dialed every boot). */
	pinnedPeers(): string[] {
		return this.knownPeers.list();
	}

	/** Live-tune how often this node re-announces itself for discovery (the "gossip cadence"), in seconds.
	 *  No-op if the mesh is off. The current value surfaces in consensus().gossipIntervalSec for the UI. */
	setGossipInterval(seconds: number): void {
		this.transport?.setAnnounceInterval(seconds);
	}

	/**
	 * Leave the current channel and join `name`. A channel is a name-based network:
	 * its own mesh, anchor chain, and economy. We
	 * tear down consensus + the current ledger/store, build a FRESH ledger + anchor
	 * chain for the new channel, rebind accounts (your keys/identity are shared
	 * across channels), replay the new channel's persisted writes, and re-join. No-op
	 * if already on `name`.
	 */
	async switchChannel(name: string): Promise<void> {
		const next = name.trim();
		if (!next || next === this.network) return;

		// 1. Tear down the current channel's consensus + storage. Stop farming FIRST so it
		//    doesn't post a write into the store while it's closing.
		this.farming = false;
		this.producer?.stop();
		this.stopHealthWatch();
		this.producer = undefined;
		if (this.transport) await this.transport.destroy().catch(() => {});
		this.transport = undefined;
		if (this.store) await this.store.close().catch(() => {});
		this.store = undefined;
		this.anchorTimes.length = 0; // reset cadence samples for the new chain

		// 2. Fresh ledger + anchor chain — a clean state for the new channel.
		this.node = this.freshNode();
		this.accounts.clear(); // bound to the old node; rebound lazily on the new one
		this.lastCheckpointHeight = -1;
		this.lastSnapshot = undefined;
		this.pendingSnapshot = undefined;
		this.setCheckpointBase(undefined);
		this.wireTipCadence();

		// 3. Switch to the new channel and bring it up (init store → replay → join + farm).
		this.network = next;
		await this.init();
		await this.startConsensus({ mesh: this.meshOn, farm: this.farmOn });
	}

	async stop(): Promise<void> {
		await this.swaps.stop();
		this.farming = false;
		this.producer?.stop();
		this.stopHealthWatch();
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
