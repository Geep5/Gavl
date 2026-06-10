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

export type SyncMessage =
	// ── write sync ───────────────────────────────────────────────
	/** Advertise my current state: root fingerprint + per-writer heads. */
	| { t: "hello"; root: string; heads: Heads }
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
	// ── distributed key generation (custody committee ceremony) ──
	/** A DKG ceremony message, routed to the node's registered DKG coordinator. */
	| { t: "dkg"; m: DkgWire };

/**
 * DKG ceremony payloads. `pkg`/`share` are FROST structures pre-encoded JSON-safe
 * (Uint8Arrays → hex markers) so they survive the wire. A `round2` share is a SECRET
 * addressed to one recipient and MUST be sent over that peer's own (encrypted)
 * connection — never broadcast.
 */
export type DkgWire =
	/** Round 1: broadcast a public commitment + proof-of-knowledge. `from` = participant id. */
	| { d: "round1"; session: string; from: string; pkg: unknown }
	/** Round 2: a secret share from `from` addressed to participant `to`. Point-to-point. */
	| { d: "round2"; session: string; from: string; to: string; share: unknown };
