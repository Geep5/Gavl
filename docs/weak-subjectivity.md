# Weak subjectivity — genesis-free bootstrap

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

- **Multi-peer agreement** — require the same `(floorId, height, weight)` from N independent peers
  before adopting. A lone peer then can't feed a fork. *(planned)*
- **Shipped checkpoints** — bake a recent `(height, anchorId)` into releases (or a signed
  well-known list), so the trust anchor is the software you installed, not whoever answers first.
  *(planned)*
- **Online assumption** — a node offline longer than the checkpoint horizon should re-verify its
  checkpoint out-of-band before trusting peers, exactly as Ethereum PoS weak-subjectivity advises.

## Determinism constraint (retarget)

With a difficulty schedule, the adopted floor must sit on an **epoch boundary** and `window ≤ epoch`,
so every difficulty recompute above the floor draws a window lying entirely above it (between
boundaries difficulty just inherits the previous value). Otherwise a recompute would dip into the
missing ancestry and diverge from a full node. `adopt()` enforces this and throws rather than adopt
into a fork; the daemon takes checkpoints on epoch boundaries when a schedule is active.
