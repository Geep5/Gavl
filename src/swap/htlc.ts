/**
 * Taproot HTLC for BTC↔LTC atomic swaps. Pure and deterministic: no I/O, no clock;
 * the only randomness is `newSecret()`.
 *
 * Output: P2TR with the BIP341 NUMS internal key H (no key path) and two tapscript leaves
 *   claim:  OP_SHA256 <hash32> OP_EQUALVERIFY <receiverXonly> OP_CHECKSIG
 *   refund: <refundBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP <senderXonly> OP_CHECKSIG
 * Spends go through the script path:
 *   claim  witness [sig, secret, claimLeaf, claimControlBlock]
 *   refund witness [sig, refundLeaf, refundControlBlock], tx version 2, nSequence = refundBlocks
 *
 * The claim leaf has no OP_SIZE check on the preimage: both chains run the same tapscript
 * rules (520-byte stack elements), so any preimage that satisfies one chain's HTLC also
 * satisfies the other's, and our secrets are always 32 bytes.
 */
import { randomBytes } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { bytesToHex, concatBytes, equalBytes, hexToBytes } from "@noble/curves/utils.js";
import { sha256 } from "../det/canonical.ts";
import { dustThreshold, NETWORKS, type Chain, type SwapNetwork } from "./networks.ts";

/** 32-byte BIP340 x-only public key. */
export type XOnly = Uint8Array;

/**
 * BIP341 "nothing up my sleeve" internal key H = lift_x(0x50929b74…3ac0), whose
 * x-coordinate is SHA256 of the uncompressed encoding of G (BIP341, "Constructing and
 * spending Taproot outputs"). A hash output cannot have been chosen with a known discrete
 * log, so the key path is unspendable and only the two leaves can move the coins.
 * Checked at load against the hash and @scure/btc-signer's TAPROOT_UNSPENDABLE_KEY.
 */
export const NUMS_INTERNAL_KEY: XOnly = hexToBytes("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");
if (!equalBytes(NUMS_INTERNAL_KEY, sha256(secp256k1.Point.BASE.toBytes(false))) || !equalBytes(NUMS_INTERNAL_KEY, btc.TAPROOT_UNSPENDABLE_KEY)) {
	throw new Error("NUMS internal key does not match SHA256(uncompressed G)");
}

/** BIP342 tapscript leaf version. */
export const TAPSCRIPT_LEAF_VERSION = 0xc0;
/** BIP68 relative block locks use the low 16 bits of nSequence. */
export const MAX_REFUND_BLOCKS = 0xffff;
/** Refund windows (hours) — initiator (secret holder, locks first) waits longer. */
export const INITIATOR_REFUND_HOURS = 24;
export const COUNTERPARTY_REFUND_HOURS = 12;
/** Claim inputs signal BIP125 replaceability so a stuck claim can be fee-bumped. */
const CLAIM_SEQUENCE = 0xfffffffd;
/** BIP340 aux randomness. Zero keeps signing deterministic; the nonce still derives from key+message (BIP340 allows this). */
const AUX_ZERO = new Uint8Array(32);

export interface HtlcParams {
	/** SHA256 of the secret. */
	hash: Uint8Array;
	/** Claims with the secret. */
	receiver: XOnly;
	/** Refunds after `refundBlocks` confirmations of the HTLC output. */
	sender: XOnly;
	/** Relative timelock in blocks (BIP68/BIP112), 1..65535. */
	refundBlocks: number;
}

export interface Htlc {
	claimLeaf: Uint8Array;
	refundLeaf: Uint8Array;
	claimControlBlock: Uint8Array;
	refundControlBlock: Uint8Array;
	merkleRoot: Uint8Array;
	/** x-only tweaked output key Q. */
	outputKey: XOnly;
	/** OP_1 <Q>. */
	scriptPubKey: Uint8Array;
	/** bech32m address of the HTLC on `network`. */
	address(network: SwapNetwork): string;
}

export interface HtlcUtxo {
	txid: string;
	vout: number;
	/** Base units (sats / litoshis). */
	amount: bigint;
}

export interface SignedSpend {
	/** Signed raw transaction, hex. */
	hex: string;
	txid: string;
	vsize: number;
	fee: bigint;
	/** Value of the single output. */
	value: bigint;
}

interface SpendCommon {
	htlcUtxo: HtlcUtxo;
	params: HtlcParams;
	/** Destination address on `network`. */
	to: string;
	/** sat/vB (fractional allowed); fee = ceil(feeRate × vsize). */
	feeRate: number;
	network: SwapNetwork;
}

export interface ClaimArgs extends SpendCommon {
	secret: Uint8Array;
	/** Receiver's 32-byte secret key. */
	receiverKey: Uint8Array;
}

export interface RefundArgs extends SpendCommon {
	/** Sender's 32-byte secret key. */
	senderKey: Uint8Array;
}

export function newSecret(): Uint8Array {
	return new Uint8Array(randomBytes(32));
}

export function hashOf(secret: Uint8Array): Uint8Array {
	return sha256(secret);
}

/** Taproot HTLC output for `params`. */
export function htlcScript(params: HtlcParams): Htlc {
	const { hash, receiver, sender, refundBlocks } = params;
	if (hash.length !== 32) throw new Error(`htlc: hash must be 32 bytes, got ${hash.length}`);
	for (const [name, key] of [["receiver", receiver], ["sender", sender]] as const) {
		if (key.length !== 32) throw new Error(`htlc: ${name} must be a 32-byte x-only key, got ${key.length}`);
		schnorr.utils.lift_x(BigInt(`0x${bytesToHex(key)}`)); // throws if not on the curve
	}
	if (!Number.isInteger(refundBlocks) || refundBlocks < 1 || refundBlocks > MAX_REFUND_BLOCKS) {
		throw new Error(`htlc: refundBlocks must be an integer in 1..${MAX_REFUND_BLOCKS}, got ${refundBlocks}`);
	}
	const claimLeaf = btc.Script.encode(["SHA256", hash, "EQUALVERIFY", receiver, "CHECKSIG"]);
	const refundLeaf = btc.Script.encode([refundBlocks, "CHECKSEQUENCEVERIFY", "DROP", sender, "CHECKSIG"]);
	const claimHash = tapLeafHash(claimLeaf);
	const refundHash = tapLeafHash(refundLeaf);
	// TapBranch hashes its children in lexicographic order (BIP341).
	const [lo, hi] = Buffer.compare(claimHash, refundHash) <= 0 ? [claimHash, refundHash] : [refundHash, claimHash];
	const merkleRoot = schnorr.utils.taggedHash("TapBranch", lo, hi);
	const [outputKey, parity] = btc.utils.taprootTweakPubkey(NUMS_INTERNAL_KEY, merkleRoot);
	// Control block: (leaf version | output-key parity) ‖ internal key ‖ sibling leaf hash.
	const controlHeader = new Uint8Array([TAPSCRIPT_LEAF_VERSION | parity]);
	const scriptPubKey = btc.OutScript.encode({ type: "tr", pubkey: outputKey });
	return {
		claimLeaf,
		refundLeaf,
		claimControlBlock: concatBytes(controlHeader, NUMS_INTERNAL_KEY, refundHash),
		refundControlBlock: concatBytes(controlHeader, NUMS_INTERNAL_KEY, claimHash),
		merkleRoot,
		outputKey,
		scriptPubKey,
		address: (network) => btc.Address(network.btc).encode({ type: "tr", pubkey: outputKey }),
	};
}

/** Receiver spends the HTLC with the secret. */
export function buildClaimTx(args: ClaimArgs): SignedSpend {
	const { secret, receiverKey, params } = args;
	if (!equalBytes(hashOf(secret), params.hash)) throw new Error("claim: secret does not hash to params.hash");
	if (!equalBytes(schnorr.getPublicKey(receiverKey), params.receiver)) throw new Error("claim: receiverKey does not match params.receiver");
	const htlc = htlcScript(params);
	return spend(args, htlc, htlc.claimLeaf, CLAIM_SEQUENCE, receiverKey, (sig) => [sig, secret, htlc.claimLeaf, htlc.claimControlBlock]);
}

/** Sender takes the HTLC back once the output has `params.refundBlocks` confirmations. */
export function buildRefundTx(args: RefundArgs): SignedSpend {
	const { senderKey, params } = args;
	if (!equalBytes(schnorr.getPublicKey(senderKey), params.sender)) throw new Error("refund: senderKey does not match params.sender");
	const htlc = htlcScript(params);
	return spend(args, htlc, htlc.refundLeaf, params.refundBlocks, senderKey, (sig) => [sig, htlc.refundLeaf, htlc.refundControlBlock]);
}

/**
 * One-input, one-output script-path spend. The witness size is fixed once the leaf is
 * chosen (64-byte SIGHASH_DEFAULT sig), so vsize is measured on the tx with a zero
 * placeholder sig; the output value is 8 bytes regardless, so fee = ceil(feeRate × vsize)
 * is exact for the signed tx.
 */
function spend(
	{ htlcUtxo, to, feeRate, network }: SpendCommon,
	htlc: Htlc,
	leaf: Uint8Array,
	sequence: number,
	key: Uint8Array,
	witness: (sig: Uint8Array) => Uint8Array[],
): SignedSpend {
	if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error(`feeRate must be a positive sat/vB, got ${feeRate}`);
	const decoded = btc.Address(network.btc).decode(to);
	if (!decoded) throw new Error(`${to} is not a ${network.chain} ${network.net} address`);
	const outScript = btc.OutScript.encode(decoded);
	const build = (value: bigint) => {
		const tx = new btc.Transaction({ version: 2, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true });
		tx.addInput({ txid: htlcUtxo.txid, index: htlcUtxo.vout, sequence, witnessUtxo: { script: htlc.scriptPubKey, amount: htlcUtxo.amount } });
		tx.addOutput({ script: outScript, amount: value });
		return tx;
	};
	const probe = build(htlcUtxo.amount);
	probe.updateInput(0, { finalScriptWitness: witness(new Uint8Array(64)) }, true);
	const vsize = probe.vsize;
	const fee = BigInt(Math.ceil(feeRate * vsize));
	const value = htlcUtxo.amount - fee;
	const dust = dustThreshold(network, outScript);
	if (value < dust) throw new Error(`output ${value} below dust ${dust} (amount ${htlcUtxo.amount}, fee ${fee} = ${feeRate} sat/vB × ${vsize} vB)`);
	const tx = build(value);
	const sighash = tx.preimageWitnessV1(0, [htlc.scriptPubKey], btc.SigHash.DEFAULT, [htlcUtxo.amount], undefined, leaf, TAPSCRIPT_LEAF_VERSION);
	tx.updateInput(0, { finalScriptWitness: witness(schnorr.sign(sighash, key, AUX_ZERO)) }, true);
	return { hex: tx.hex, txid: tx.id, vsize, fee, value };
}

/**
 * The secret revealed by a claim of the HTLC locked to `hash`: the second element of any
 * 4-element (claim-shaped) witness in `claimTxHex` whose SHA256 equals `hash`.
 */
export function extractSecret(claimTxHex: string, hash: Uint8Array): Uint8Array {
	const { witnesses = [] } = btc.RawTx.decode(hexToBytes(claimTxHex));
	for (const w of witnesses) {
		if (w.length === 4 && w[1].length === 32 && equalBytes(sha256(w[1]), hash)) return Uint8Array.from(w[1]);
	}
	throw new Error(`no preimage of ${bytesToHex(hash)} in tx witnesses`);
}

/** Blocks covering `hours` at the chain's target spacing (rounded up). */
export function minRefundBlocks(chain: Chain, hours: number): number {
	if (!Number.isFinite(hours) || hours <= 0) throw new Error(`hours must be positive, got ${hours}`);
	const blocks = Math.ceil((hours * 3600) / NETWORKS[chain].mainnet.blockSeconds);
	if (blocks > MAX_REFUND_BLOCKS) throw new Error(`${hours}h is ${blocks} ${chain} blocks, above the BIP68 maximum ${MAX_REFUND_BLOCKS}`);
	return blocks;
}

/** Default refund window: initiator 24h, counterparty 12h (BTC 144/72, LTC 576/288). */
export function defaultRefundBlocks(chain: Chain, role: "initiator" | "counterparty"): number {
	return minRefundBlocks(chain, role === "initiator" ? INITIATOR_REFUND_HOURS : COUNTERPARTY_REFUND_HOURS);
}
