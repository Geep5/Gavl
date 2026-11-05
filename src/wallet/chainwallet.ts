/**
 * Hot wallet for one chain + network, over an Esplora client (src/chains/esplora.ts).
 *
 * Key: `walletKey(seed, chain, net)` (src/swap/keys.ts) — one key, one address per (chain, net).
 * Address: P2TR key path per BIP86 — internal key P = xonly(walletKey), output key
 *   Q = P + taggedHash("TapTweak", P)·G (no script tree), spent with a 64-byte SIGHASH_DEFAULT
 *   BIP340 signature by the tweaked secret key. Deposits and change both land here.
 *
 * Coin selection (`pay`): largest-first over the spendable UTXOs — confirmed ones plus unconfirmed
 * change of txs this instance broadcast (never someone else's unconfirmed, replaceable deposit).
 * Inputs are added until the target is covered at the exact fee: vsize is measured on the real
 * transaction with zero placeholder signatures (key-path witnesses are a fixed 64 bytes, output
 * values a fixed 8), and fee = ceil(feeRate × vsize). If the leftover after that fee would be a
 * dust change output (< dustThreshold of our P2TR script), the change is dropped and the leftover
 * goes to the fee instead.
 *
 * Calls that build transactions are serialized, and outpoints this instance spent stay excluded
 * until the explorer stops listing them, so concurrent `fundHtlc` / `send` never double-select.
 */
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import type { Chain, Esplora, Net } from "../chains/esplora.ts";
import { walletKey } from "../swap/keys.ts";
import { dustThreshold, swapNetwork, type SwapNetwork } from "../swap/networks.ts";
import { MAX_PROOF_UTXOS, signFundsProof, type FundsProof } from "../swap/proof.ts";

/** Inputs signal BIP125 replaceability so a stuck payment can be fee-bumped. */
const SEQUENCE = 0xfffffffd;
/** BIP340 aux randomness. Zero keeps signing deterministic; the nonce still derives from key + message. */
const AUX_ZERO = new Uint8Array(32);

export interface WalletUtxo {
	txid: string;
	vout: number;
	/** Base units (sats / litoshis). */
	value: bigint;
	confirmed: boolean;
}

export interface Balance {
	confirmed: bigint;
	/** Mempool outputs to the wallet not yet spent in the mempool. */
	unconfirmed: bigint;
}

export interface PayArgs {
	/** Destination address on this wallet's chain/net. */
	to: string;
	/** Exact amount the destination output receives, base units. */
	amount: bigint;
	/** sat/vB (fractional allowed); fee = ceil(feeRate × vsize), plus any dust leftover. */
	feeRate: number;
}

export interface Payment {
	txid: string;
	/** Index of the output paying `to`. */
	vout: number;
	/** Inputs − outputs, base units. */
	fee: bigint;
	vsize: number;
	/** Signed raw transaction, hex (already broadcast). */
	hex: string;
}

export class ChainWallet {
	readonly chain: Chain;
	readonly net: Net;
	readonly network: SwapNetwork;
	/** BIP86 internal key (x-only) — the `pubkey` of this wallet's funds proofs. */
	readonly pubkey: Uint8Array;
	/** This wallet's P2TR scriptPubKey (OP_1 <Q>). */
	readonly script: Uint8Array;
	private readonly addr: string;
	private readonly esplora: Esplora;
	private readonly key: Uint8Array;
	private readonly tweakedKey: Uint8Array;
	/** Txids this instance broadcast: their unconfirmed change is spendable. */
	private readonly ownTxids = new Set<string>();
	/** Outpoints this instance spent that the explorer may still list. */
	private readonly spent = new Set<string>();
	private queue: Promise<unknown> = Promise.resolve();

	/** The wallet of Gavl account `seed` on `esplora`'s chain and network. */
	constructor(seed: Uint8Array, esplora: Esplora) {
		this.chain = esplora.chain;
		this.net = esplora.net;
		this.network = swapNetwork(this.chain, this.net);
		this.esplora = esplora;
		this.key = walletKey(seed, this.chain, this.net);
		this.pubkey = schnorr.getPublicKey(this.key);
		this.tweakedKey = taprootTweakPrivKey(this.key);
		const p2tr = btc.p2tr(this.pubkey, undefined, this.network.btc);
		this.addr = p2tr.address!;
		this.script = p2tr.script;
	}

	/** The wallet's single receive + change address: BIP86 key-path P2TR (bech32m). */
	address(): string {
		return this.addr;
	}

	/** Every UTXO the explorer lists for the wallet address (confirmed + mempool, minus mempool-spent). */
	async utxos(): Promise<WalletUtxo[]> {
		const rows = await this.esplora.utxos(this.addr);
		return rows.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: u.status.confirmed }));
	}

	async balance(): Promise<Balance> {
		const b: Balance = { confirmed: 0n, unconfirmed: 0n };
		for (const u of await this.utxos()) {
			if (u.confirmed) b.confirmed += u.value;
			else b.unconfirmed += u.value;
		}
		return b;
	}

	/** Lock `amount` into an HTLC (a P2TR address from `htlcScript(...).address(network)`). */
	async fundHtlc(args: PayArgs): Promise<Payment> {
		const decoded = btc.Address(this.network.btc).decode(args.to);
		if (decoded?.type !== "tr") throw new Error(`fundHtlc: ${args.to} is not a P2TR (HTLC) address`);
		return this.pay(args);
	}

	/** Withdraw `amount` to an external address. */
	send(args: PayArgs): Promise<Payment> {
		return this.pay(args);
	}

	/**
	 * A funds proof for `matchId` covering at least `required`: the largest confirmed UTXOs first,
	 * at most MAX_PROOF_UTXOS. Throws if the confirmed balance in that many UTXOs falls short.
	 */
	async proveFunds(matchId: string, required: bigint): Promise<FundsProof> {
		const confirmed = (await this.utxos()).filter((u) => u.confirmed).sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
		const picked: WalletUtxo[] = [];
		let sum = 0n;
		for (const u of confirmed) {
			if (sum >= required && picked.length > 0) break;
			if (picked.length === MAX_PROOF_UTXOS) break;
			picked.push(u);
			sum += u.value;
		}
		if (sum < required || picked.length === 0) throw new Error(`proveFunds: ${sum} confirmed in ≤ ${MAX_PROOF_UTXOS} utxos, need ${required}`);
		const utxos = picked.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value.toString() }));
		return signFundsProof(this.key, matchId, this.chain, this.net, utxos);
	}

	private pay(args: PayArgs): Promise<Payment> {
		const run = () => this.payNow(args);
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => {});
		return p;
	}

	private async payNow({ to, amount, feeRate }: PayArgs): Promise<Payment> {
		if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error(`feeRate must be a positive sat/vB, got ${feeRate}`);
		const decoded = btc.Address(this.network.btc).decode(to);
		if (!decoded) throw new Error(`${to} is not a ${this.chain} ${this.net} address`);
		const outScript = btc.OutScript.encode(decoded);
		const minOut = dustThreshold(this.network, outScript);
		if (amount < minOut) throw new Error(`amount ${amount} below dust ${minOut} for ${to}`);
		const changeDust = dustThreshold(this.network, this.script);

		const listed = await this.utxos();
		const live = new Set(listed.map((u) => `${u.txid}:${u.vout}`));
		for (const o of this.spent) if (!live.has(o)) this.spent.delete(o); // explorer caught up
		const spendable = listed
			.filter((u) => !this.spent.has(`${u.txid}:${u.vout}`) && (u.confirmed || this.ownTxids.has(u.txid)))
			.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));

		const inputs: WalletUtxo[] = [];
		let inSum = 0n;
		for (const u of spendable) {
			inputs.push(u);
			inSum += u.value;
			if (inSum < amount) continue;
			const withChange = this.vsize(inputs, outScript, true);
			const change = inSum - amount - BigInt(Math.ceil(feeRate * withChange));
			if (change >= changeDust) return this.signAndBroadcast(inputs, outScript, amount, change, withChange);
			const noChange = this.vsize(inputs, outScript, false);
			if (inSum - amount >= BigInt(Math.ceil(feeRate * noChange))) return this.signAndBroadcast(inputs, outScript, amount, null, noChange); // dust leftover → fee
		}
		const total = spendable.reduce((s, u) => s + u.value, 0n);
		throw new Error(`insufficient funds: ${total} spendable at ${this.addr}, need ${amount} + fee at ${feeRate} sat/vB`);
	}

	/** Target output at index 0, change (if any) at index 1. */
	private build(inputs: WalletUtxo[], outScript: Uint8Array, amount: bigint, change: bigint | null): btc.Transaction {
		const tx = new btc.Transaction({ version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true });
		for (const u of inputs) tx.addInput({ txid: u.txid, index: u.vout, sequence: SEQUENCE, witnessUtxo: { script: this.script, amount: u.value } });
		tx.addOutput({ script: outScript, amount });
		if (change !== null) tx.addOutput({ script: this.script, amount: change });
		return tx;
	}

	/** vsize of the signed tx: key-path witnesses are one 64-byte sig each, so zeros measure exactly. */
	private vsize(inputs: WalletUtxo[], outScript: Uint8Array, withChange: boolean): number {
		const tx = this.build(inputs, outScript, 0n, withChange ? 0n : null);
		for (let i = 0; i < inputs.length; i++) tx.updateInput(i, { finalScriptWitness: [new Uint8Array(64)] }, true);
		return tx.vsize;
	}

	/** BIP341 key-path spend of every input (SIGHASH_DEFAULT, BIP86-tweaked key), then broadcast. */
	private async signAndBroadcast(inputs: WalletUtxo[], outScript: Uint8Array, amount: bigint, change: bigint | null, vsize: number): Promise<Payment> {
		const tx = this.build(inputs, outScript, amount, change);
		const scripts = inputs.map(() => this.script);
		const amounts = inputs.map((u) => u.value);
		for (let i = 0; i < inputs.length; i++) {
			const sighash = tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts);
			tx.updateInput(i, { finalScriptWitness: [schnorr.sign(sighash, this.tweakedKey, AUX_ZERO)] }, true);
		}
		const hex = tx.hex;
		const txid = await this.esplora.broadcast(hex);
		if (txid !== tx.id) throw new Error(`broadcast returned ${txid}, expected ${tx.id}`);
		this.ownTxids.add(txid);
		for (const u of inputs) this.spent.add(`${u.txid}:${u.vout}`);
		const inSum = amounts.reduce((s, v) => s + v, 0n);
		return { txid, vout: 0, fee: inSum - amount - (change ?? 0n), vsize, hex };
	}
}
