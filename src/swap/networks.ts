/**
 * Chain parameters for the BTC↔LTC atomic swap: @scure/btc-signer network objects
 * (address encoding) plus the policy/timing metadata the swap needs (block spacing for
 * hours→blocks conversion, dust and min-relay fee rates).
 *
 * Sources (line numbers at the cited tags):
 *
 * Bitcoin Core v32.1, src/kernel/chainparams.cpp
 *   mainnet  L176 PUBKEY_ADDRESS 0, L177 SCRIPT_ADDRESS 5, L178 SECRET_KEY 128, L182 bech32_hrp "bc",   L128 nPowTargetSpacing 10*60
 *   testnet  = TESTNET4 (CTestNet4Params): L409 PUBKEY_ADDRESS 111, L410 SCRIPT_ADDRESS 196, L411 SECRET_KEY 239, L415 bech32_hrp "tb",
 *            L364 nPowTargetSpacing 10*60 — the same prefixes as testnet3 (L296-302) and signet (L564-570)
 *   regtest  L672 PUBKEY_ADDRESS 111, L673 SCRIPT_ADDRESS 196, L674 SECRET_KEY 239, L678 bech32_hrp "bcrt", L605 nPowTargetSpacing 10*60
 * Bitcoin Core v32.1, src/policy/policy.h
 *   L68 DUST_RELAY_TX_FEE 3000 sat/kvB, L70 DEFAULT_MIN_RELAY_TX_FEE 100 sat/kvB
 *
 * Litecoin Core v0.21.5.8, src/chainparams.cpp
 *   mainnet  L145 PUBKEY_ADDRESS 48, L147 SCRIPT_ADDRESS2 50, L148 SECRET_KEY 176, L152 bech32_hrp "ltc",  L87 nPowTargetSpacing 2.5*60
 *   testnet  L257 PUBKEY_ADDRESS 111, L259 SCRIPT_ADDRESS2 58, L260 SECRET_KEY 239, L264 bech32_hrp "tltc", L212 nPowTargetSpacing 2.5*60
 *   regtest  L371 PUBKEY_ADDRESS 111, L373 SCRIPT_ADDRESS2 58, L374 SECRET_KEY 239, L378 bech32_hrp "rltc", L311 nPowTargetSpacing 2.5*60
 *   P2SH: the node ENCODES with SCRIPT_ADDRESS2 (src/key_io.cpp L37) and still decodes the
 *   legacy SCRIPT_ADDRESS (5 / 196, key_io.cpp L97), so `scriptHash` is SCRIPT_ADDRESS2.
 * Litecoin Core v0.21.5.8, src/policy/policy.h L52 DUST_RELAY_TX_FEE 30000 lit/kvB;
 *   src/validation.h L56 DEFAULT_MIN_RELAY_TX_FEE 1000 lit/kvB.
 *
 * The regtest entries equal test/regtest/node.ts REGTEST_NETWORKS (asserted by
 * test/swap-htlc.test.ts), which smoke.test.ts round-trips against the real nodes.
 */
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import type { Chain, Net } from "../chains/esplora.ts";

export type { Chain, Net } from "../chains/esplora.ts";
export type { BTC_NETWORK } from "@scure/btc-signer/utils.js";

export interface SwapNetwork {
	chain: Chain;
	net: Net;
	/** Address/WIF encoding for @scure/btc-signer (`Address(network.btc)`, `WIF(network.btc)`). */
	btc: BTC_NETWORK;
	/** Consensus target block spacing (nPowTargetSpacing), seconds. */
	blockSeconds: number;
	/** Default `-dustrelayfee` (DUST_RELAY_TX_FEE), base units per 1000 vbytes. */
	dustRelayFeePerKvB: number;
	/** Default `-minrelaytxfee` (DEFAULT_MIN_RELAY_TX_FEE), base units per 1000 vbytes. */
	minRelayFeePerKvB: number;
}

const BTC_POLICY = { blockSeconds: 600, dustRelayFeePerKvB: 3000, minRelayFeePerKvB: 100 } as const;
const LTC_POLICY = { blockSeconds: 150, dustRelayFeePerKvB: 30_000, minRelayFeePerKvB: 1000 } as const;

export const NETWORKS: Readonly<Record<Chain, Readonly<Record<Net, Readonly<SwapNetwork>>>>> = Object.freeze({
	bitcoin: Object.freeze({
		mainnet: Object.freeze({ chain: "bitcoin", net: "mainnet", btc: Object.freeze({ bech32: "bc", pubKeyHash: 0, scriptHash: 5, wif: 128 }), ...BTC_POLICY }),
		testnet: Object.freeze({ chain: "bitcoin", net: "testnet", btc: Object.freeze({ bech32: "tb", pubKeyHash: 111, scriptHash: 196, wif: 239 }), ...BTC_POLICY }),
		regtest: Object.freeze({ chain: "bitcoin", net: "regtest", btc: Object.freeze({ bech32: "bcrt", pubKeyHash: 111, scriptHash: 196, wif: 239 }), ...BTC_POLICY }),
	}),
	litecoin: Object.freeze({
		mainnet: Object.freeze({ chain: "litecoin", net: "mainnet", btc: Object.freeze({ bech32: "ltc", pubKeyHash: 48, scriptHash: 50, wif: 176 }), ...LTC_POLICY }),
		testnet: Object.freeze({ chain: "litecoin", net: "testnet", btc: Object.freeze({ bech32: "tltc", pubKeyHash: 111, scriptHash: 58, wif: 239 }), ...LTC_POLICY }),
		regtest: Object.freeze({ chain: "litecoin", net: "regtest", btc: Object.freeze({ bech32: "rltc", pubKeyHash: 111, scriptHash: 58, wif: 239 }), ...LTC_POLICY }),
	}),
});

export function swapNetwork(chain: Chain, net: Net): SwapNetwork {
	return NETWORKS[chain][net];
}

/**
 * Smallest non-dust value for an output paying `script` — Core's GetDustThreshold
 * (bitcoin src/policy/policy.cpp, litecoin src/policy/policy.cpp, identical): the
 * serialized output (8-byte value + compact-size script length + script) plus the size
 * of a typical spending input (67 vbytes for witness programs, 148 otherwise), priced at
 * the chain's dust relay fee. An output is dust iff `value < dustThreshold(…)`.
 */
export function dustThreshold(network: SwapNetwork, script: Uint8Array): bigint {
	if (script.length > 0 && script[0] === 0x6a) return 0n; // OP_RETURN: unspendable, never dust
	const outSize = 8 + (script.length < 0xfd ? 1 : 3) + script.length; // value + compact-size length (scripts ≤ 10 000 bytes) + script
	const inSize = isWitnessProgram(script) ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4;
	// CFeeRate::GetFee: size × rate / 1000 (bitcoin rounds up, litecoin truncates; both default rates are multiples of 1000, so exact).
	return BigInt(Math.floor(((outSize + inSize) * network.dustRelayFeePerKvB) / 1000));
}

/** CScript::IsWitnessProgram: OP_0 or OP_1..OP_16 followed by one direct push of 2..40 bytes. */
function isWitnessProgram(script: Uint8Array): boolean {
	if (script.length < 4 || script.length > 42) return false;
	if (script[0] !== 0x00 && (script[0] < 0x51 || script[0] > 0x60)) return false;
	return script[1] + 2 === script.length;
}
