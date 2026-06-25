# Cutting the network over to real PoST

This is the operator playbook for moving a running channel from the **stand-in** proofs
(`GAVL_VDF=hash`, `space=standin`) to **real Proof-of-Space-and-Time** (`chiavdf` + `chiapos`).

## Why this is a coordinated upgrade, not a per-node switch

The proof system is a **network-wide consensus rule**, not a node preference. Each node wires
exactly one space verifier and one VDF at startup
([`daemon.ts`](../src/server.ts) → `ChiaSpaceVerifier | StandinSpaceVerifier`; `params.vdf`), and
uses it to verify *every* anchor. A real-PoST node therefore **cannot verify stand-in anchors**, and
stand-in nodes cannot verify chiapos/chiavdf anchors. One real node among stand-in peers does not
join their chain — it forks to its own and sits at height 0 (real proofs work, but there is no one
to share the chain with). See `are-we-producing-post` discussion / the single-verifier wiring.

So real PoST only *means* anything once the network rejects stand-ins. Mixing the two (a verifier
that accepts both `anchor.space.kind`s) is technically possible but **security-pointless** — a chain
that accepts a stand-in anchor is only as strong as the stand-in. Don't do that.

## The cutover seam: a weak-subjectivity checkpoint

We use the mechanism Gavl already has ([`weak-subjectivity.md`](weak-subjectivity.md)). A node that
adopts a checkpoint floor **does not re-verify the PoST below it** — it takes the floor's history on
faith and verifies only anchors *above* it. That is exactly what lets us change proof systems at a
height boundary:

```
... stand-in anchors ...  [ checkpoint floor @ height N ]  real-PoST anchors ...
        (below N: trusted, never re-verified)         (above N: pure chiapos + chiavdf)
```

A fresh chiapos node that adopts the checkpoint at N **never has to verify a stand-in anchor** — the
floor is trusted, and everything it builds/accepts above N is real PoST. No mixed verifier, no code
change to consensus.

## Prerequisites (every farming operator)

1. **Chia bridge** — `python3 -m venv .venv && .venv/bin/pip install chiavdf chiapos`.
2. **Real-PoST config** — real PoST (`GAVL_VDF=chia`, `GAVL_SPACE=chiapos`) is the default; run
   `npm run setup:chia` once for the bridge (see the README "Real PoST vs. the stand-ins" section).
   Agree on a common `GAVL_K` (defaults to 18 for chiapos; e.g. set 20) so every node carries
   comparable space; plotting is one-time and reused.
3. **≥3 farmers.** The custody committee runs genesis DKG only with ≥3 farmers — below that, minting
   stays disabled. Line up at least three real-PoST nodes before cutover.

## Procedure

1. **Pick the floor `(N, anchorId)`.** On the live stand-in chain, take a *finalized* checkpoint
   boundary — the largest `CHECKPOINT_EVERY` boundary the finalized anchor has crossed (Gavl
   checkpoints deterministically at these boundaries, so every honest node has the *same* anchor at
   N). Record `N` and its `anchorId` from `/api/state` (`consensus.finalizedHeight` / `tip`).
2. **Distribute `(N, anchorId)` out-of-band.** Share it through a channel the operators already
   trust (signed message / the ops chat) — *not* "whatever the first peer offers." Until shipped
   checkpoints land (planned, see weak-subjectivity.md), this agreed pair is your trust root.
3. **Set `adoptQuorum: 2+`** on each node so no single/sybil peer can feed a fabricated floor. With
   a small operator set, set it to the number of independent operators you trust.
4. **Coordinated restart.** Around height N, every operator restarts in real-PoST mode. Fresh nodes
   adopt the checkpoint at N and begin folding/producing real-PoST anchors above it.
5. **Stand-in holdouts fork off.** Nodes that don't switch keep extending a stand-in chain above N
   that the real-PoST nodes can't verify and will ignore. The real-PoST chain is the one real-PoST
   nodes agree on. (There is no in-code "reject stand-ins above N" flag — it's enforced implicitly
   because chiapos nodes simply can't verify stand-in anchors.)

## Verify the cutover took

```bash
curl -s localhost:6440/api/state | jq '.consensus | {vdf, space, finalizedHeight, tip, producers, iProduce}'
```
Expect `vdf: "chiavdf-wesolowski-1024"`, `space: "chiapos"`, and `tip.height` climbing **above N**
across the real-PoST nodes, with `producers ≥ 3`.

## Honest caveats

- **Production rate is slow at first.** A few small (k=18–20) plots = little space, so anchors come
  slowly until difficulty retargets down to the new (real) space/time budget. Expect a lag right
  after cutover; watch `secPerAnchor` settle.
- **Trust root is the agreed floor, not cryptography.** Adopting a checkpoint trusts that `(N,
  anchorId)` is real finalized history. `adoptQuorum` raises the bar to "N independent operators
  aren't colluding," but it is not a cryptographic guarantee — hence distributing the pair
  out-of-band. Baked-in shipped checkpoints would harden this further (planned, not yet shipped).
- **No automatic downgrade.** `GAVL_VDF=chia` throws if the bridge is missing — a misconfigured
  operator fails loudly rather than silently rejoining as a stand-in. That's intended.
