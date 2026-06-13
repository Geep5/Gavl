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
import type { Offer } from "../market/intent.ts";

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
	// ── matched-market intents (non-binding, off-ledger gossip) ──
	/** A single broadcast intent (signed offer) — propagated epidemically across the mesh. */
	| { t: "intent"; offer: Offer }
	/** A peer's whole resting offer book, sent once on connect so a new node sees the tape. */
	| { t: "intents"; offers: Offer[] }
	// ── anchor (consensus) sync ──────────────────────────────────
	/** Advertise my heaviest anchor tip. */
	| { t: "anchor-tip"; height: number; weight: string; id: string }
	/** Ask for a peer's tip chain from `fromHeight` upward. */
	| { t: "anchor-want"; fromHeight: number }
	/** Serve anchors along the tip chain. */
	| { t: "anchor-chain"; anchors: Anchor[] }
	// ── distributed key generation (custody committee ceremony) ──
	/** A DKG ceremony message, routed to the node's registered DKG coordinator. */
	| { t: "dkg"; m: DkgWire }
	/** A signing ceremony message, routed to the node's registered signing coordinator. */
	| { t: "sign"; m: SignWire }
	/** A reshare ceremony message, routed to the node's registered reshare coordinator. */
	| { t: "reshare"; m: ReshareWire };

/**
 * DKG ceremony payloads. `pkg`/`share` are FROST structures pre-encoded JSON-safe
 * (Uint8Arrays → hex markers) so they survive the wire. A `round2` share is a SECRET
 * addressed to one recipient and MUST be sent over that peer's own (encrypted)
 * connection — never broadcast.
 */
export type DkgWire =
	/** Round 1: broadcast a public commitment + proof-of-knowledge. `from` = participant id. */
	| { d: "round1"; session: string; from: string; pkg: unknown; sig?: string }
	/** Round 2: a secret share from `from` addressed to participant `to`. Point-to-point. */
	| { d: "round2"; session: string; from: string; to: string; share: unknown; sig?: string };

/**
 * Distributed SIGNING ceremony payloads. A quorum co-signs a message using each
 * member's own share — only public NONCE COMMITMENTS and SIGNATURE SHARES cross the
 * wire (never the share itself). All broadcast: nothing here is secret.
 */
export type SignWire =
	/** Round 1: a signer's nonce commitments for `sign` over `msg` (hex). `from` = signer id. */
	| { s: "commit"; sign: string; from: string; commit: unknown; sig?: string }
	/** Round 2: a signer's signature share (safe to broadcast — useless without a quorum). */
	| { s: "share"; sign: string; from: string; share: unknown; sig?: string };

/**
 * Committee RESHARE ceremony payloads — rotate the fund key to a new committee
 * (same group key). An old member's `sub` carries a SECRET sub-share to one new
 * member (point-to-point, like DKG round-2); a new member's `vshare` is its public
 * verifying share (broadcast, to assemble the new package).
 */
export type ReshareWire =
	/** Announce participation so peers learn id→connection (for routing sub-shares). */
	| { r: "hello"; session: string; from: string; sig?: string }
	/** SECRET sub-share from an old member `from` to a new member `to`. Point-to-point. */
	| { r: "sub"; session: string; from: string; to: string; share: unknown; sig?: string }
	/** A new member's verifying share g^newShare (public). */
	| { r: "vshare"; session: string; from: string; v: unknown; sig?: string };
