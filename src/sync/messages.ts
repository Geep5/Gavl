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
import type { EncKeyAnnounce } from "../custody/enckey.ts";
import type { Deal } from "../custody/pvss.ts";

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
	| { t: "snapshot-have"; anchorId: string; height: number }
	// ── distributed key generation (custody committee ceremony) ──
	/** A DKG ceremony message, routed to the node's registered DKG coordinator. */
	| { t: "dkg"; m: DkgWire }
	/** A signing ceremony message, routed to the node's registered signing coordinator. */
	| { t: "sign"; m: SignWire }
	/** A reshare ceremony message, routed to the node's registered reshare coordinator. */
	| { t: "reshare"; m: ReshareWire }
	/** A member's self-signed encryption-key announcement (verifiable encrypted resharing, phase 1).
	 *  Broadcast + re-broadcast so peers learn which X25519 key to seal a reshare sub-share to. */
	| { t: "enckey"; a: EncKeyAnnounce }
	/** A SHADOW reshare contribution deal (verifiable encrypted resharing, phase 2 shadow run). Old
	 *  members broadcast these alongside the live ceremony so the blob path can be assembled + verified
	 *  live WITHOUT being trusted — pure validation, never consumed for an actual share. */
	| { t: "shadowdeal"; epoch: number; deal: Deal };

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
