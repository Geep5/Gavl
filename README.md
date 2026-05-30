# Gavl

A decentralized auction house on a **Proof-of-Space-Time cooldown ledger**, built on
[Holepunch](https://github.com/holepunchto) (hypercore / hyperswarm / hyperdht).

No servers, no global chain to replay from genesis. State lives in RAM and is verified
against your current peers. Every write must pay a **cooldown** — a proof of space
(committed plot) *and* a proof of time (VDF) — so an attacker can't spin up a swarm of
cheap identities to flood or grind the network.

## Why Space *and* Time

The cooldown has to be bound to something an attacker can't multiply by making more
identities. One mechanism alone isn't enough:

| Proof | Scarce resource | Stops |
|---|---|---|
| **Space** (committed plot) | disk per identity | Sybil — "spin up a ton of nodes" now costs a ton of disk |
| **Time** (VDF) | sequential compute | parallel speed-up — more machines don't write faster |

Together they're Chia's Proof-of-Space-Time: space gives per-identity cost, time gives
fair, ungrindable pacing. Each write carries both proofs plus an Ed25519 signature, and
**verifies in isolation** — no ancestry walk. That's what makes "verify with your current
peers" cheap and "RAM chain / no genesis replay" possible.

### The Chia-style coupling

Space and time aren't two separate gates — they're bound, the way Chia binds them:

- **Quality → cooldown.** A proof of space has a *quality*; that quality sets the
  required VDF iterations. More space ⇒ rarer (better) proofs ⇒ fewer iterations ⇒
  shorter cooldown. Space buys throughput, proportionally. (`src/chain/iters.ts`)
- **Infusion.** The VDF runs over a challenge that folds in the proof of space, so a
  time proof is bound to one specific space proof — you can't reuse a VDF.
- **Trunk vs foliage.** The challenge is derived only from chain position
  (`writer, seq, prev, stateRoot`), never the payload, so you can't grind a cheaper
  cooldown by varying what you write. `prev` chains to the previous write's VDF output,
  so future challenges stay unpredictable until the sequential work reveals them.
- **Weight.** Each write carries difficulty; a chain accrues cumulative weight — the
  input to heaviest-chain fork choice (cross-writer selection lands in P2).

Double-spending means emitting two writes at the same sequence number — forking your own
chain. That's self-evident equivocation: a portable fraud proof the live set slashes on.
No global total order required.

## Layout — P0 (cooldown) + P1 (mesh + sync)

```
src/det/canonical.ts   deterministic canonical bytes + sha256
src/det/ed25519.ts     raw-key Ed25519 (ported from glon)
src/pot/vdf.ts         Proof of Time — VDF interface
src/pot/hash-vdf.ts    reference VDF: sequential SHA-256 chain  (P0 stand-in)
src/pos/space.ts       Proof of Space — committed Merkle plot + verifier
src/chain/iters.ts     Chia-style consensus math: quality→required-iters, infusion, weight
src/chain/writer.ts    the per-writer PoST chain + equivocation detection
src/ledger/ledger.ts   multi-writer RAM ledger: chains, heads, stateRoot, out-of-order buffer
src/sync/node.ts       gossip protocol: writes (hello/want/writes/announce) + anchors (tip/want/chain)
src/sync/messages.ts   wire message shapes
src/sync/memory.ts     in-memory transport (deterministic, offline tests)
src/sync/swarm.ts      real Hyperswarm transport — the Holepunch mesh
src/auction/ops.ts     auction-house op types (transfer / create / bid / settle / cancel)
src/auction/state.ts   pure view: writes → balances + items + auctions, with conservation
src/auction/account.ts wallet + auctioneer: produce op-writes, query the view
src/consensus/anchor.ts   PoST-proven anchor certifying a snapshot of writer-heads
src/consensus/chain.ts    heaviest-weight fork choice + depth finality
src/consensus/order.ts    anchor-bound canonical order → finalized (ts-attack-proof) view
src/consensus/difficulty.ts  retarget difficulty toward a target iters-per-anchor
src/consensus/producer.ts the farming loop: mine an anchor over the heaviest tip, gossip it
src/consensus/space.ts    pluggable anchor space backend: SpaceProver/Verifier + stand-in engine
src/pos/chia.ts           real chiapos Proof-of-Space backend for anchors
src/pot/chia-vdf.ts       real Proof of Time — chiavdf Wesolowski VDF (the default Vdf)
src/chia/proc.ts          Python bridge to chiavdf + chiapos (sync + async variants)
src/config.ts             composition root — defaultParams() resolves the real chiavdf
scripts/chia_proofs.py    the Python helper wrapping chiavdf + chiapos
test/                     P0 cooldown · P1 ledger/sync/mesh · P3 auction · P2 anchors/fork-choice · real chia
```

> Default `npm test` runs everything (incl. real chia + live mesh) when `.venv` is present;
> the chia tests skip cleanly otherwise. `npm run test:fast` skips chia + mesh for quick iteration.

### Real proofs — chiavdf / chiapos (the default)

A running Gavl node uses the **real Chia primitives** by default — `defaultParams()` in
[src/config.ts](src/config.ts) resolves to **chiavdf**, so the cooldown is genuine wall-clock
time. The lightweight stand-ins remain available for fast, zero-dependency tests and dev.

- **`ChiaVdf`** ([src/pot/chia-vdf.ts](src/pot/chia-vdf.ts)) implements `Vdf` using **chiavdf**'s
  Wesolowski VDF over a 1024-bit class group — real non-parallelizable sequential time, cheap
  to verify. `eval` is **async** (it runs in a subprocess) so a node keeps gossiping while the
  VDF computes — a node doing network I/O must never block its event loop on a multi-second
  primitive. `verify` stays synchronous (Wesolowski verification is ≈O(1)), keeping the hot
  gossip-receive path fast.
- **`ChiaSpaceProver`/`ChiaSpaceVerifier`** ([src/pos/chia.ts](src/pos/chia.ts)) wrap **chiapos**
  at the anchor layer (the pluggable `SpaceProver`/`SpaceVerifier` from
  [src/consensus/space.ts](src/consensus/space.ts)). A plot is *probabilistic* — a challenge
  yields a proof only sometimes (Chia's farming lottery) — which is exactly the anchor/"block"
  lottery. The plot id is bound to the producer's key, so no one can present another's plot.

Both shell out to a small Python helper ([scripts/chia_proofs.py](scripts/chia_proofs.py)) —
async (`execFile`) for the VDF eval path, sync (`spawnSync`) elsewhere. Set up the venv once:

```bash
python3.12 -m venv .venv
.venv/bin/pip install chiavdf chiapos
```

Defaulting to `chia` **fails loudly** if the bridge is missing — Gavl never silently downgrades
the cooldown to the insecure stand-in. Use `GAVL_VDF=hash` to opt into the stand-in explicitly
(that's what `npm run test:fast` and the core suite use). `test/chia.test.ts` proves a real-VDF
PoST write verifies through the pipeline and a real chiapos anchor mines + verifies.

### How sync works (P1)

State is every known writer's chain, held in RAM — no genesis replay, because each write
is self-verifying. The `stateRoot` is a cheap commitment over writer *heads*. Two peers are
"in sync" exactly when their roots match. On connect they exchange `hello` (root + heads),
each pulls what it lacks (`want` → `writes`), and new writes spread by `announce`. The same
protocol runs over an in-memory link (tests) or real Hyperswarm sockets; peers find each
other on `sha256(networkName)` — the topic string *is* the network identity.

### The auction house (P3)

The app rides on top as op payloads: `transfer`, `auction.create / bid / settle / cancel`.
The view is a pure replay of all writes → balances + items + auctions:

- **Native token (GAV).** No mint authority — every write earns its writer a farming
  reward, so issuance is proportional to space via the cooldown (Chia-style). You earn GAV
  by participating and spend it in auctions.
- **Authorization is free.** Each op is already signed by its write, so the op's actor *is*
  `write.writer`; only the seller can settle their own auction.
- **Escrow + conservation.** A bid locks the bidder's GAV; settle pays the seller, hands the
  item to the winner, and refunds the losers; invalid ops (overspend, self-bid, non-seller
  settle) are deterministically skipped. GAV is never created or destroyed outside the reward.

Two views coexist: `computeView` is the optimistic tip (provisional `ts` order), and
`finalizedView` is the safe state behind the consensus layer (below).

### Consensus (P2)

Per-writer chains already make conservation safe (every debit is in the debitor's own
seq-ordered chain; double-spending needs equivocation, which is a fork proof). What they
don't give is canonical cross-account order, finality, or Sybil-bound agreement. An
**anchor chain** provides them, Chia-style:

- **Anchors.** An anchor is a PoST-proven certificate (same space+time machinery as a write)
  of a snapshot of writer-heads. Its challenge chains from the previous anchor's VDF output,
  so the sequence is unpredictable and ungrindable.
- **Fork choice.** Follow the **heaviest cumulative weight** chain. Out-running it needs
  majority space. A heavier fork reorgs; an anchor `k` deep is final (reorging it costs `k`
  anchors of PoST).
- **Canonical order.** Writes fold in **anchor-epoch** order — the height of the first anchor
  that certified them — so cross-account funding order is bound to PoST weight, not `ts`. The
  `ts` field can no longer be used to grief settlement across an anchor boundary. (Intra-epoch,
  order falls back to the honest declared `ts`, like transaction order within a block.)
- **Difficulty retarget.** Scale difficulty toward a target iters-per-anchor, holding the
  anchor interval steady as total network space changes.
- **Checkpoints.** A finalized anchor commits heads + stateRoot + cumulative weight, so a
  fresh node trusts the heaviest chain's finalized tip and fetches only the writes up to it —
  no genesis replay. A lighter (eclipse) fork is rejected by weight.

Anchors gossip over the same mesh as writes (`anchor-tip / anchor-want / anchor-chain`), and a
`Producer` farms them over the heaviest tip — so consensus runs end-to-end across nodes. See
`npm run demo:consensus`: two nodes farm and gossip anchors over a real hyperdht mesh and
finalize the same settled auction.

#### Real Proof-of-Space (chiapos)

The anchor space backend is pluggable (`src/consensus/space.ts`). The default stand-in is a
light Merkle plot (fast, deterministic — used by all the consensus tests). For genuine
disk-bound space, `src/pos/chia.ts` drives real **chiapos** through a Python helper. Setup:

```bash
python3.12 -m venv .venv && .venv/bin/pip install chiavdf chiapos
node --test test/chiapos-anchor.test.ts   # plots a real k=18 plot once (cached), mines a real anchor
```

A plot is a real file under `~/.gavl/plots/` whose id is bound to the producer's key, so a
producer can't present someone else's plot. Quality from chiapos's verifier feeds the same
`requiredIters` coupling (normalized by expected plot size). The matching real VDF (chiavdf)
slots into the existing `Vdf` interface the same way — that's the next step.

## Run

Needs Node ≥ 23.6 (native TypeScript — no build step). You're on Node 26.

```bash
npm test            # full suite: PoST primitive + ledger + gossip + mesh + auction
npm run demo        # build + verify a PoST chain, showing space→cooldown
npm run demo:auction  # run a live auction between two nodes over a real hyperdht mesh
npm run demo:consensus  # two nodes farm + gossip anchors, finalize the same settled auction
```

## Roadmap

- **P0 — cooldown primitive** ✅ per-writer PoST chain, Chia-style quality→cooldown coupling, infusion, trunk/foliage split, weight, self-verifying writes, fork proofs
- **P1 — RAM state + gossip** ✅ multi-writer RAM ledger; `stateRoot` compare + diff pull ("are we in sync?"); epidemic announce; real hyperswarm/hyperdht mesh (topic = network identity)
- **P2 — consensus** ✅ anchor chain (PoST-proven head certificates); heaviest-weight fork choice + depth finality; anchor-epoch canonical order (neutralizes the `ts` attack); difficulty retargeting; weight-trusted checkpoints for cold-start bootstrap
- **P3 — the auction house** ✅ native token (GAV) as a per-write farming reward; `transfer` + `auction.create/bid/settle/cancel` with escrow, conservation, and seller-authority; runs live across the mesh
- **Consensus is live** ✅ anchors gossip over the mesh + a producer farms them (`demo:consensus`)
- **Real proofs by default** ✅ chiavdf (proof of time) is the **default** cooldown via `defaultParams()` (async eval so gossip never blocks); chiapos (proof of space) secures anchors; both run live in `demo:consensus`
- **P4 — hardening** eclipse-resistant peer sampling; log/anchor pruning + snapshots; incremental (non-replay) view computation
