/**
 * Hardcoded genesis — the chain's fixed block 0, baked in like Bitcoin's.
 *
 * Genesis is NOT mined at runtime. A runtime seeder election races under network latency: two nodes
 * each seed their own genesis before hearing the other, producing parallel chains of equal weight that
 * fork-choice can never merge (heaviest-chain is winner-take-all, but neither dominates) — the network
 * splits permanently. Instead every node DERIVES the identical genesis deterministically from the
 * network label + base difficulty and installs it as the root (AnchorChain.installGenesis). No
 * election, no race: all nodes start from a byte-identical block 0, so they can only ever be on ONE
 * chain. Genesis is the root of trust — accepted by hardcoding, never re-validated against the normal
 * proof rules (exactly as Bitcoin nodes ship with, and never re-mine, their genesis block).
 */
import type { Anchor, AnchorBody } from "./anchor.ts";
import type { TimeProof } from "../pot/vdf.ts";
import { sha256, sha256Hex, canonicalBytes, toHex, concatBytes } from "../det/canonical.ts";
import { rootOfHeads } from "../ledger/ledger.ts";

/** Genesis's "producer" is a SENTINEL, not a real farmer — committee selection skips it (see epoch.ts).
 *  A 32-byte zero key, which no real Ed25519 producer can present (it isn't a valid signing identity). */
export const GENESIS_PRODUCER = "00".repeat(32);

const GENESIS_DOMAIN = "gavl-genesis-v1";

/**
 * The deterministic genesis anchor for `network` at base `difficulty`. PURE + FIXED: identical inputs
 * yield a byte-identical anchor (same id) on every node, so each installs the same block 0 with no
 * gossip and no minting. `appRoot` is the empty app-state root, passed in so this module stays
 * consensus-only; it's committed for completeness but never re-validated for the root. The space proof,
 * VDF, and signature are placeholders — genesis carries no real proof (it's accepted by hardcoding).
 * `time.output` seeds height-1's challenge (anchorChallenge), so it's a deterministic network-bound hex.
 */
export function genesisAnchor(opts: { network: string; difficulty: bigint; appRoot: string }): Anchor {
	const seed = toHex(sha256(concatBytes(Buffer.from(GENESIS_DOMAIN, "utf8"), Buffer.from(opts.network, "utf8"))));
	const body: AnchorBody = {
		height: 0,
		prev: null,
		producer: GENESIS_PRODUCER,
		nonce: 0,
		step: [],
		difficulty: opts.difficulty.toString(),
		headsDelta: {},
		stateRoot: rootOfHeads({}), // genesis certifies the empty write set
		appRoot: opts.appRoot,
		weight: opts.difficulty.toString(), // cumulative weight = own difficulty (the base of the sum)
		space: { kind: "genesis", id: seed, k: 0 }, // placeholder commitment — never verified
		proof: null,
	};
	const time: TimeProof = { iters: 0, output: seed, proof: "" }; // placeholder VDF; output seeds height-1
	const id = sha256Hex(canonicalBytes({ body, time }));
	return { ...body, time, id, sig: "" };
}
