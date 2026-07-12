/**
 * I2P bootstrap seeds — the cold-start "phone book" (NOT a coordinator, NOT the rendezvous PEX replaced).
 *
 * A brand-new node with no persisted `known-peers.json` has to dial SOMEONE to get its first stream;
 * after that, egalitarian PEX (peers gossip the peers they know) floods it the live mesh and these
 * seeds are never used again. Seeds are UNTRUSTED introducers: every anchor a peer serves is verified
 * against PoST + fork-choice, so a hostile seed can't feed a fake chain — it can only decline to
 * introduce you. And the set is plural + replaceable — anyone can run one (add your address below),
 * no single seed is privileged or load-bearing, and losing ALL of them affects only NEW cold starts,
 * never the running network (nodes already meshed keep talking). This is the same shape Bitcoin ships
 * (hardcoded DNS seeds + fixed node IPs as fallback) and I2P itself uses (hardcoded HTTPS reseeds);
 * "zero hardcoded addresses" is not achievable for any P2P network and is not what decentralization
 * means — no ongoing authority, untrusted introductions, and PEX after the first hello is.
 *
 * Each entry is an I2P b32 (52-char base32; the node resolves it as `<b32>.b32.i2p`). At runtime,
 * `GAVL_I2P_PEERS` (comma-separated) adds more and takes precedence in ordering; a pinned peer in
 * `~/.gavl/known-peers.json` is redialed every boot independently. To disable the built-ins entirely
 * (e.g. an isolated private fleet), set `GAVL_I2P_SEEDS=off`.
 */
export const I2P_BOOTSTRAP_SEEDS: readonly string[] = [
	"wxrd2l6g4el35ynnrw4en6wkgsgsn6vskmd6es5ztj2rbogoobha", // seat-0 (2026-07-12) — first live I2P node
	// Add more stable, long-running node b32s here. More seeds = better cold-start resilience; there is
	// no cap and no ranking — a fresh node dials them all and keeps whichever answer first.
];

/** The effective seed list for a boot: built-ins (unless GAVL_I2P_SEEDS=off) + GAVL_I2P_PEERS, deduped. */
export function bootstrapSeeds(env: NodeJS.ProcessEnv = process.env): string[] {
	const fromEnv = (env.GAVL_I2P_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	const builtins = env.GAVL_I2P_SEEDS === "off" ? [] : [...I2P_BOOTSTRAP_SEEDS];
	return [...new Set([...fromEnv, ...builtins])]; // env first (operator override), then the shipped set
}
