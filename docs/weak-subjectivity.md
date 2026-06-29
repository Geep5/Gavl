# Weak subjectivity — genesis-free bootstrap

> **Update — hardcoded genesis.** Block 0 is now a fixed constant every node derives identically and
> installs as the locked root ([`src/consensus/genesis.ts`](../src/consensus/genesis.ts),
> `AnchorChain.installGenesis`). There is no genesis *minting* anymore and a competing block 0 is
> rejected, so the short-range genesis **race** this note's checkpoint model worked around is gone — all
> nodes start from one shared origin. The checkpoint/adopt mechanism below is retained for **long-range**
> security (PoST history stays grindable far back, like any PoS-class chain), and the two are now
> **reconciled by sequencing**: `daemon.bootstrapChainRoot()` first gives the mesh a grace window to offer
> a checkpoint and `adopt`s it if one arrives (JOIN the heaviest existing network); only when nothing is
> offered — a cold-start or a young chain — does it fall through to `installGenesis` (SEED). So genesis is
> the bootstrap seed *for when there's nothing to join*, and it's pruned away once the chain matures into
> checkpoints. Convergence itself is unchanged: follow the heaviest cumulative-PoST chain.

Gavl nodes never replay from genesis. A fresh node loads a recent finalized **checkpoint** and
folds forward. This is fast and bounds storage — but it means trust is rooted in a *recent
checkpoint*, not in the origin block. That is a deliberate design choice with a real, named
trade-off. This note states it plainly.

## Why genesis can't be the root of trust

The genesis anchor is intentionally **grindable and unprovable**. It folds in a free `nonce` so a
producer can find a challenge its plot answers, and `GENESIS_SEED` is a constant
([`src/consensus/anchor.ts`](../src/consensus/anchor.ts)). Anyone can mint a genesis. So "verify the
chain back to genesis" secures nothing — there is no privileged origin to anchor trust to. Trust
must instead flow from a **recent finalized checkpoint** that the network already agrees on.

## How adoption works

`AnchorChain.adopt(floor, floorHeads)` ([`src/consensus/chain.ts`](../src/consensus/chain.ts)) is the
mirror of `prune()`:

- **prune** drops anchors *below* a floor a node walked down to.
- **adopt** installs a floor a node *received*, without ever holding the ancestry beneath it.

A fresh node:

1. Pulls a checkpoint (`snapshot-offer` → `snapshot-want` → `snapshot`).
2. Receives the pruned anchor suffix `[floor … tip]`; it can't link the bottom to the (absent)
   genesis.
3. **Adopts** the checkpoint's anchor as a trusted floor — its PoST is *not* re-verified to genesis
   — inheriting its committed cumulative weight.
4. Links the suffix above the floor, verifying every anchor normally (PoST, prev-link, difficulty
   retarget, appRoot).
5. **Authenticates the state** cryptographically: the checkpoint's child anchor commits its
   `appRoot`, and `viewRoot(snapshot.state)` must equal it (`ingestSnapshot`).

After bootstrap, an adopted node is **indistinguishable** from a long-running node that pruned to the
same floor — genesis is just "the floor of a node that never pruned."

## What is and isn't trusted

- **Trusted (the assumption):** that the *floor anchor itself* is the real finalized history — its
  weight and that it descends from the true chain. Its PoST work back to genesis is taken on faith.
- **Not trusted (still verified):** everything above the floor (all PoST, retarget, links), and the
  **entire committed state** at the checkpoint (bound by the child anchor's `appRoot`).

So a malicious peer that feeds a *self-consistent fake history* (fake floor + matching fake suffix +
matching fake state) can deceive a node that trusts only that one peer. It cannot forge state that
doesn't match the floor it presents, but it can present an entirely fabricated floor.

## Hardening (where the floor enters)

The mechanism is sound; the *trust in the floor* is what must be hardened operationally:

- **Multi-peer agreement (implemented).** A fresh node adopts a checkpoint only after
  `adoptQuorum` **distinct peers** offer the *same* checkpoint anchor. Peers are deduped by their
  stable wire identity (`peerKey`), so one peer opening many connections can't manufacture
  agreement. Default is `1` (trust the first peer — fine for dev / a single trusted bootstrap);
  set `adoptQuorum: 2+` in production so a lone or sybil peer can't feed a fabricated floor.
  Implemented in `GavlNode.snapshotQuorumMet` + the daemon's `adoptFloor` gate.
- **Deterministic checkpoint cadence (implemented).** Nodes checkpoint at a fixed height — the
  largest `CHECKPOINT_EVERY` boundary the finalized anchor has crossed — not at each node's current
  finalized tip. So every honest node checkpoints the *same* anchor, which is what makes a quorum of
  identical offers actually achievable (`maybeCheckpoint`).
- **Shipped checkpoints (planned).** Bake a recent `(height, anchorId)` into releases (or a signed
  well-known list), so the trust anchor is the software you installed, not whoever answers first.
- **Online assumption.** A node offline longer than the checkpoint horizon should re-verify its
  checkpoint out-of-band before trusting peers, exactly as Ethereum PoS weak-subjectivity advises.

> Quorum raises the bar from "trust one peer" to "trust that N independent peers aren't all
> colluding," but it is not a cryptographic guarantee — N sybil identities (distinct pubkeys) still
> defeat it. Shipped checkpoints are the stronger anchor; quorum is the cheap, always-on default.

## Determinism constraint (retarget)

With a difficulty schedule, the adopted floor must sit on an **epoch boundary** and `window ≤ epoch`,
so every difficulty recompute above the floor draws a window lying entirely above it (between
boundaries difficulty just inherits the previous value). Otherwise a recompute would dip into the
missing ancestry and diverge from a full node. `adopt()` enforces this and throws rather than adopt
into a fork; the daemon takes checkpoints on epoch boundaries when a schedule is active.
