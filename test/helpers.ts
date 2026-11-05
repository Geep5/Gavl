/** Shared test fixtures: low-difficulty params and a chain builder. */

import { Writer } from "../src/chain/writer.ts";
import type { ChainParams, Write } from "../src/chain/writer.ts";
import { HashVdf } from "../src/pot/hash-vdf.ts";
import { Plot } from "../src/pos/space.ts";
import { StandinSpaceProver, StandinSpaceVerifier } from "../src/consensus/space.ts";
import type { SpaceProver } from "../src/consensus/space.ts";
import type { KeyPair } from "../src/det/ed25519.ts";
import { computeView, holderAt, custodyRules } from "../src/market/btc.ts";
import type { AnchorView, CustodyParams } from "../src/custody/epoch.ts";
import type { View, CustodyState } from "../src/market/btc.ts";
import type { Op } from "../src/market/ops.ts";
import type { RotationConfig } from "../src/custody/rotation.ts";
import type { StoredShare } from "../src/custody/share-store.ts";
import { mintFromDeposit } from "../src/custody/bridge.ts";
import { generateFundKeyDKG, thresholdSign, quorumOf } from "../src/custody/threshold.ts";
import type { FundKey } from "../src/custody/threshold.ts";
import { depositAttestationDigest } from "../src/custody/attestation.ts";
import { toHex, fromHex } from "../src/det/canonical.ts";
import type { Account } from "../src/market/account.ts";

/** Seed gBTC balances directly into a fold base. Minting is committee-gated now (a threshold sig
 *  over the group key — see TestFund), but economic/consensus tests only need balances to EXIST,
 *  not to exercise the mint authorization, so we put them straight in the resume base (1:1 backed,
 *  so `marketConserved` holds). Use TestFund when the test is actually about mint authorization. */
export function withGbtc(base: View, balances: Record<string, bigint>): View {
	let i = 0;
	for (const [pub, amt] of Object.entries(balances)) mintFromDeposit(base.bridge, { depositId: "seed:" + i++, depositor: pub, amount: amt }, 0);
	return base;
}

/** A test committee fund: a DKG'd group key seeded into a fold base (as a settled genesis
 *  custody.fund would leave it — the real announce needs the chain-sampled committee's unanimous
 *  endorsement, see custody-handoff.test.ts), then minted against with a threshold signature — the
 *  real authorization path now that the single-attestor fallback is gone. */
export class TestFund {
	readonly key: FundKey;
	private n = 0;
	constructor(min = 2, max = 3) {
		this.key = generateFundKeyDKG(min, max);
	}
	get groupKeyHex(): string {
		return toHex(this.key.groupPubKey);
	}
	/** `base` (default: empty) with this fund established at `epoch` and its dealt identifiers as the
	 *  genesis holder. Mutates and returns `base`. */
	seed(base: View = computeView([]), epoch = 1): View {
		base.custody.fundKey = this.groupKeyHex;
		base.custody.epoch = epoch;
		base.custody.holder = { epoch, committee: Object.keys(this.key.shares).sort(), min: this.key.min, since: 0 };
		return base;
	}
	/** A quorum-signed `bridge.deposit` minting `amount` to `depositor`, relayed by `via` (any node).
	 *  `depositId` defaults to a fresh outpoint; pass one to satisfy a specific claim. */
	fund(via: Account, depositor: string, amount: bigint, depositId = "tf" + this.n++ + ":0") {
		const sig = toHex(thresholdSign(depositAttestationDigest({ depositId, depositor, amount }), this.key.pub, quorumOf(this.key, this.key.min)));
		return via.attestDeposit(depositId, depositor, amount, sig);
	}
}

/** Low difficulty so multi-write, multi-node tests stay quick. */
export const PARAMS: ChainParams = {
	vdf: new HashVdf(),
	difficulty: 20n,
	dcf: 1n << 20n,
	floorIters: 500n,
};

export const K = 11; // 2,048-leaf plot
const ROOT0 = "00".repeat(32);

/** Build an identity and produce `n` valid writes in sequence. */
export async function makeChain(n: number, params: ChainParams = PARAMS, k: number = K): Promise<{ writer: Writer; writes: Write[] }> {
	const writer = new Writer({ k, params });
	const writes: Write[] = [];
	let prev: string | null = null;
	for (let i = 0; i < n; i++) {
		const w = await writer.write({ prev, seq: i, stateRoot: ROOT0, payload: { i }, ts: i });
		writes.push(w);
		prev = w.id;
	}
	return { writer, writes };
}

/** Shared stand-in space backend for fast anchor tests (no plotting). */
export const STANDIN_VERIFIER = new StandinSpaceVerifier();
export function standinProver(keypair: KeyPair, k: number = K): SpaceProver {
	return new StandinSpaceProver(new Plot(keypair.publicKey, k));
}

export async function waitFor(pred: () => boolean, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`waitFor: condition not met within ${ms}ms`);
}

/**
 * The custody slice of the chain, for rotation tests that drive CommitteeRotation without a full
 * daemon: every publishFund / publishHandoff becomes a write BY THAT NODE (its id is its producer
 * key) folded by the REAL fold (computeView + custodyRules over `chainAt(height)` with the network's
 * CustodyParams), certified at `height` (set it to where the record would land). holderAt /
 * handoffRecorded read the folded state. Shares live in a per-node, per-epoch map like the daemon's
 * ShareStore.
 */
export class CustodyLedger {
	height = 0;
	private readonly writes: Write[] = [];
	private readonly bornAt = new Map<string, number>();
	readonly shares = new Map<string, Map<number, StoredShare>>();
	private readonly chainAt: (height: number) => AnchorView[];
	private readonly params: CustodyParams;

	constructor(chainAt: (height: number) => AnchorView[], params: CustodyParams) {
		this.chainAt = chainAt;
		this.params = params;
	}

	custody(): CustodyState {
		return computeView(this.writes, { bornAt: this.bornAt, nowHeight: this.height, custodyRules: custodyRules(this.chainAt(this.height), this.params, true) }).custody;
	}
	private post(writer: string, payload: Op): void {
		const id = `w${this.writes.length}`;
		this.writes.push({ id, writer, seq: this.writes.length, ts: this.writes.length, payload } as unknown as Write);
		this.bornAt.set(id, this.height);
	}
	share(id: string, epoch: number): StoredShare | null {
		return this.shares.get(id)?.get(epoch) ?? null;
	}
	/** The RotationConfig callbacks for node `id`. */
	hooks(id: string): Pick<RotationConfig, "groupKey" | "fundEpoch" | "holderAt" | "handoffRecorded" | "publishFund" | "publishHandoff" | "loadShare" | "saveShare"> {
		return {
			groupKey: () => {
				const k = this.custody().fundKey;
				return k ? fromHex(k) : null;
			},
			fundEpoch: () => {
				const e = this.custody().epoch;
				return e >= 0 ? e : null;
			},
			holderAt: (h) => holderAt(this.custody(), h),
			handoffRecorded: (epoch) => (this.custody().holder?.epoch ?? -1) >= epoch,
			publishFund: (key, epoch, committee, min) => this.post(id, { kind: "custody.fund", groupKey: toHex(key), epoch, committee: [...committee].sort(), min }),
			publishHandoff: (epoch, committee, min, sig) => this.post(id, { kind: "custody.handoff", epoch, committee, min, sig: toHex(sig) }),
			loadShare: (epoch) => this.share(id, epoch),
			saveShare: (s) => {
				if (!this.shares.has(id)) this.shares.set(id, new Map());
				this.shares.get(id)!.set(s.epoch, s);
			},
		};
	}
}
