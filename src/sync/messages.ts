/**
 * Sync wire messages. Plain JSON over the transport (length-prefixed on the
 * swarm; structured-cloned in memory). Kept tiny and self-describing.
 *
 * Two families: WRITE sync (the per-writer op chains) and ANCHOR sync (the
 * consensus chain). Both ride the same connection.
 */

import type { Write } from "../chain/writer.ts";
import type { Heads } from "../ledger/ledger.ts";
import type { Anchor } from "../consensus/anchor.ts";
import type { StoredSnapshot } from "../store/store.ts";

export type SyncMessage =
	// ── write sync ───────────────────────────────────────────────
	/** Advertise my current state: root fingerprint + per-writer heads. `mode` is my PoST proof mode
	 *  (`<vdf>/<space>`) — peers compare it to detect an incompatible-proof mismatch (a real-PoST node
	 *  among stand-in peers, or vice versa, can't share a chain). `genesis` is my network's DETERMINISTIC
	 *  block-0 id — peers compare it to detect a different-genesis split (a peer on old code that minted
	 *  its own block 0; same label + same mode, but anchors silently rejected). */
	| { t: "hello"; root: string; heads: Heads; mode?: string; genesis?: string }
	/** Ask a peer for writer→fromSeq (inclusive) that I'm missing. */
	| { t: "want"; from: Record<string, number> }
	/** Serve requested writes. */
	| { t: "writes"; writes: Write[] }
	/** Push freshly-applied writes to peers (epidemic gossip). */
	| { t: "announce"; writes: Write[] }
	// ── anchor (consensus) sync ──────────────────────────────────
	/** Advertise my heaviest anchor tip. */
	| { t: "anchor-tip"; height: number; weight: string; id: string }
	/** Ask for a peer's tip chain from `fromHeight` upward. */
	| { t: "anchor-want"; fromHeight: number }
	/** Serve anchors along the tip chain. */
	| { t: "anchor-chain"; anchors: Anchor[] }
	// ── checkpoint bootstrap (a fresh peer loads state, not history) ──
	/** Advertise my latest durable checkpoint on connect (so a fresh peer can skip history). */
	| { t: "snapshot-offer"; anchorId: string; height: number }
	/** Ask a peer to send its full checkpoint. */
	| { t: "snapshot-want" }
	/** Serve the full checkpoint (committed state + heads at a finalized anchor). */
	| { t: "snapshot"; snap: StoredSnapshot }
	/** Availability beacon: "I durably hold this checkpoint and can serve it." Re-broadcast
	 *  periodically and on each new checkpoint so the network can count how many nodes still
	 *  hold the latest finalized state — the replication floor that keeps RAM state alive across
	 *  churn. Unlike `snapshot-offer`, this never triggers a bootstrap pull on a synced node;
	 *  it's purely an availability advertisement. See docs/replication-floor.md. */
	| { t: "snapshot-have"; anchorId: string; height: number };
