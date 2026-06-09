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
import { Account } from "./market/account.ts";
import { computeView, finalizedView } from "./market/btc.ts";
import type { View } from "./market/btc.ts";
import { oracleKeyPair, bridgeKeyPair } from "./market/oracle.ts";
import { fundKeyFromSeed } from "./custody/threshold.ts";
import type { FundKey } from "./custody/threshold.ts";
import { fundAddress as deriveFundAddress } from "./custody/bitcoin.ts";
import { buildWithdrawalTx, signWithdrawalTx } from "./custody/btctx.ts";
import { Esplora } from "./custody/esplora.ts";
import { checkDeposit, utxosToInputs, MIN_CONFIRMATIONS } from "./custody/watcher.ts";
import { readPriceAggregate } from "./market/pricefeed.ts";
import type { PriceSource, AggregateReading } from "./market/pricefeed.ts";
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
import { SwarmTransport } from "./sync/swarm.ts";
import { KnownPeers } from "./sync/known-peers.ts";
import { BootstrapList } from "./sync/bootstrap.ts";
import { generateKeyPair } from "./det/ed25519.ts";
import { toHex } from "./det/canonical.ts";
import { WriteStore } from "./store/store.ts";
import { KeepAllPolicy, MinePolicy } from "./store/policy.ts";
import type { PersistPolicy } from "./store/policy.ts";
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

export class Daemon {
	readonly node: GavlNode;
	readonly wallet: Wallet;
	readonly knownPeers = new KnownPeers();
	readonly bootstrap: BootstrapList;
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
	private publishing = false;
	private lastOracleSource: (AggregateReading & { at: number }) | null = null;
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
		this.bootstrap = new BootstrapList(undefined, opts.bootstrapEnv);
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

		// Replay persisted writes into the ledger BEFORE going live. Seed the logical
		// clock past the highest replayed ts so new writes are GLOBALLY monotonic —
		// otherwise a restart resets ts to 0, colliding with persisted writes and
		// scrambling the optimistic (ts-ordered) fold.
		const { writes } = await this.store.replay((w) => {
			this.node.ledger.apply(w);
			if (w.ts > this.clock) this.clock = w.ts;
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
			this.transport = new SwarmTransport(this.node, { bootstrap: this.bootstrap.forSwarm() });
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
	async startConsensus(opts: { network?: string; mesh: boolean; farm: boolean; publishOracle?: { seedHex?: string; sources: PriceSource[]; everyMs: number } }): Promise<void> {
		if (opts.network) this.network = opts.network;
		this.meshOn = opts.mesh;
		this.farmOn = opts.farm;

		if (opts.mesh) await this.joinMesh();

		if (opts.publishOracle) this.startOraclePublisher(opts.publishOracle);

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

	/**
	 * Run the BTC oracle publisher: an Account holding the oracle key that fetches a
	 * real price from `source` (HTTP endpoint + JSON key-path, or a fixed dev value),
	 * then signs + submits an `oracle.post` every `everyMs` with a monotonic seq.
	 * Only the node holding the oracle seed runs this; everyone else folds the signed
	 * posts. Each fetch is recorded (endpoint, key, raw, value) for transparency.
	 */
	private startOraclePublisher(opts: { seedHex?: string; sources: PriceSource[]; everyMs: number }): void {
		const kp = oracleKeyPair(opts.seedHex);
		const oraclePub = toHex(kp.publicKey);
		const oracle = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: kp });
		// The methodology disclosed on-chain so EVERY client sees the sources (not just
		// this node). Only feeds with a real endpoint are disclosed (a fixed dev price
		// has none). Re-posted periodically so late-joining nodes pick it up.
		const disclose = opts.sources.filter((s) => s.url).map((s) => ({ endpoint: s.url!, key: s.key ?? "" }));
		this.publishing = true;
		const loop = async () => {
			// seq continues from whatever the chain already has (survives restarts).
			let seq = (this.view().oracle.seq ?? -1) + 1;
			let tick = 0;
			while (this.publishing) {
				// disclose methodology on-chain at start + every ~30 ticks (cheap, idempotent).
				if (disclose.length > 0 && tick % 30 === 0) {
					try {
						await oracle.postMeta(oraclePub, disclose);
					} catch {
						/* retry next cycle */
					}
				}
				tick++;
				const agg = await readPriceAggregate(opts.sources); // fetch all, average the responders
				this.lastOracleSource = { ...agg, at: Date.now() }; // display-only metadata
				if (agg.value != null) {
					try {
						await oracle.postPrice(oraclePub, agg.value, seq);
						seq++;
					} catch {
						/* a post failed (e.g. mid-restart) — retry next tick */
					}
				}
				await new Promise((r) => setTimeout(r, opts.everyMs));
			}
		};
		void loop();
		console.log(`  oracle: publishing BTC price as ${oraclePub.slice(0, 16)}… (avg of ${opts.sources.length} source(s)) every ${opts.everyMs}ms`);
	}

	/** The publisher's latest aggregate reading (per-source endpoint/key/raw/value +
	 *  the average), or null if this node isn't publishing. Local metadata, never on-chain. */
	oracleSource(): (AggregateReading & { at: number }) | null {
		return this.lastOracleSource;
	}

	/**
	 * DEV: mint test gBTC to `depositor` by attesting a synthetic deposit with the
	 * bridge attestor key (which this dev node holds). This stands in for real
	 * BTC-deposit detection — the gBTC is backed by a CLAIMED reserve, not a real
	 * on-chain BTC tx. Clearly a testnet faucet; prefer claimDeposit for real coins.
	 */
	private bridgeAcct?: Account;
	private attestor(): Account {
		if (!this.bridgeAcct) this.bridgeAcct = new Account({ node: this.node, params: this.params, k: this.k, now: this.now, keypair: bridgeKeyPair(process.env.GAVL_BRIDGE_SEED) });
		return this.bridgeAcct;
	}
	async attestTestDeposit(depositor: string, amount: bigint | number | string): Promise<void> {
		await this.attestor().attestDeposit(`test-${depositor.slice(0, 8)}-${this.now()}:0`, depositor, amount);
	}

	// ── real-BTC bridge (testnet) ────────────────────────────────────

	/** The threshold-custody fund key. TESTNET single-operator (this node holds all
	 *  shares, deterministic from GAVL_FUND_SEED). Production = distributed DKG. */
	private fundKeyCache?: FundKey;
	private fundKey(): FundKey {
		if (!this.fundKeyCache) this.fundKeyCache = fundKeyFromSeed(2, 3, process.env.GAVL_FUND_SEED ?? "gavl-testnet-fund-v1");
		return this.fundKeyCache;
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
	/** The fund's Bitcoin deposit address — send real (testnet) BTC here. */
	fundAddress(): string {
		return deriveFundAddress(this.fundKey(), this.btcNetwork());
	}

	/**
	 * Verify a real BTC deposit `txid` paid the fund (via Esplora), and attest each
	 * fund output → mints gBTC 1:1 to `depositor`. Idempotent by txid:vout. Returns
	 * the total credited (0 if not found / not confirmed deep enough).
	 */
	async claimDeposit(txid: string, depositor: string): Promise<bigint> {
		const deps = await checkDeposit(this.esplora(), this.fundAddress(), txid, MIN_CONFIRMATIONS);
		let total = 0n;
		for (const d of deps) {
			await this.attestor().attestDeposit(`${d.txid}:${d.vout}`, depositor, d.amount);
			total += d.amount;
		}
		return total;
	}

	/**
	 * Settle all pending withdrawals: fetch the fund's UTXOs, build ONE payout tx to
	 * the pending recipients (+ change back to the fund, − fee), threshold-sign it,
	 * broadcast via Esplora, then mark each withdrawal settled. Returns the broadcast
	 * txid, or null if there's nothing pending / insufficient confirmed UTXOs.
	 */
	async processWithdrawals(feeSats = 1_000n): Promise<string | null> {
		const pending = this.view().bridge.pending;
		if (pending.length === 0) return null;
		const esplora = this.esplora();
		const tip = await esplora.tipHeight();
		const inputs = utxosToInputs(await esplora.utxos(this.fundAddress()), MIN_CONFIRMATIONS, tip);
		const inSum = inputs.reduce((a, u) => a + u.amount, 0n);
		const payouts = pending.map((w) => ({ address: w.btcAddress, amount: w.amount }));
		const outSum = payouts.reduce((a, p) => a + p.amount, 0n);
		if (inputs.length === 0 || inSum < outSum + feeSats) return null; // not enough confirmed BTC yet
		const change = inSum - outSum - feeSats;
		if (change > 0n) payouts.push({ address: this.fundAddress(), amount: change });
		const unsigned = buildWithdrawalTx(this.fundKey(), { inputs, outputs: payouts, network: this.btcNetwork() });
		const quorum = Object.fromEntries(Object.entries(this.fundKey().shares).slice(0, this.fundKey().min));
		const { hex } = signWithdrawalTx(unsigned, this.fundKey(), quorum);
		const txid = await esplora.broadcast(hex);
		for (const w of pending) await this.attestor().settleWithdrawal(w.id);
		return txid;
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
