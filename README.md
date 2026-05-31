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
src/auction/ops.ts     op types: coin.deploy / transfer / auction.create|bid|settle|cancel
src/auction/state.ts   pure view: writes → coins + (token,pubkey) balances + items + auctions
src/auction/account.ts wallet + auctioneer: deploy coins, produce op-writes, query the view
src/wallet.ts          multi-identity keystore (~/.gavl/wallet.json)
src/daemon.ts          boots Ledger + node + one Account per identity (shared clock)
src/server.ts          localhost JSON API the web UI drives
web/                   Vite + Svelte SPA (wallet, listings, deploy-coin, create-listing)
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

### The auction house (P3) — coin-agnostic

The app rides on top as op payloads: `coin.deploy`, `transfer`, `auction.create / bid /
settle / cancel`. The view is a pure replay of all writes → coins + balances + items +
auctions. **No token is privileged** — the protocol mints nothing on its own; the cooldown
only rate-limits writes.

- **Coins are user-deployed.** Anyone runs `coin.deploy {name, symbol, supply}`; the coin's
  id is the deploy-write's content-address, and the full supply is minted to the deployer.
  Balances are keyed by `(token, pubkey)` and no code path special-cases any id.
- **List an item *or* an amount of a coin.** An auction's `give` is either a fresh unique
  item or a fungible `{token, amount}`. The `ask` (optional) and every `bid` name their coin
  explicitly, so you can list in one coin and be paid in another.
- **Authorization is free.** Each op is signed by its write, so the op's actor *is*
  `write.writer`; only the seller can settle or cancel their own auction.
- **Escrow + per-token conservation.** Creating a coin-auction escrows the give out of the
  seller's balance; a bid locks the bidder's coins. Settle pays the seller in the winning
  bid's coin, hands the give to the winner, and refunds losers; cancel returns everything.
  Invalid ops (overspend, self-bid, non-seller settle) are deterministically skipped, and no
  coin is created or destroyed outside its own `coin.deploy`.

Two views coexist: `computeView` is the optimistic tip (provisional `ts` order), and
`finalizedView` is the safe state behind the consensus layer (below).

### Web UI + daemon

A Svelte SPA (`web/`) drives a localhost daemon (`src/daemon.ts` + `src/server.ts`) that
holds the wallet and produces writes — the VDF cooldown must run server-side, so the browser
is a thin control panel over a JSON API. The daemon holds multiple identities with an in-UI
switcher (so you can list as one account and bid as another locally). Run it:

```bash
npm run daemon     # JSON API on :6440, real chiavdf + live mesh + anchor farming
npm run web:dev    # Vite SPA on :5180, proxying /api → the daemon
```

By default the daemon runs **real consensus**: it joins the live hyperswarm/hyperdht mesh
(gossiping writes *and* anchors) and farms anchors over the heaviest tip with the real chiavdf
cooldown. The UI's Consensus panel shows it advancing — anchor height, chain weight, finalized
depth, peer count — and a settled auction gains a **✓ final** badge once an anchor certifies it.
Env knobs: `GAVL_VDF=hash` (fast stand-in VDF), `GAVL_SPACE=chiapos` (real disk-cost space
proof instead of the stand-in), `GAVL_MESH=0` (local only), `GAVL_FARM=0` (don't produce
anchors), `GAVL_RETARGET=0` (constant difficulty), `GAVL_TARGET_ITERS=<n>` (per-anchor VDF
cost target), `GAVL_NETWORK=<topic>` (the topic string *is* the network identity).

#### Hardening against the fast-VDF reorg

The realistic attack on a heaviest-chain consensus is a *reorg*: out-produce a private fork and
revert recent history. Three things blunt it, all on by default:

- **Difficulty is the pace, not a timer.** A deterministic retarget schedule (`consensus/difficulty.ts`)
  scales per-anchor difficulty toward a target VDF cost. Since weight = Σ difficulty and
  required-iters ∝ difficulty, out-producing the chain means out-computing its *aggregate*
  sequential work — there is no software pacing delay to simply delete. Producer and verifier
  derive the same difficulty from the parent chain, so they never reject each other.
- **Real Proof of Space (`GAVL_SPACE=chiapos`).** With chiapos, producing anchors costs real
  disk per identity — restoring the Sybil resistance the stand-in plot lacks. The stand-in
  remains the default for instant boot; the consensus mechanics are identical either way.
- **Sticky finality.** Once a node has seen the tip reach finality depth over an anchor, that
  anchor is *locked*: any fork that doesn't descend from it is rejected, even if heavier. A
  fast attacker can still win the unfinalized tip, but **cannot revert a finalized settlement** —
  the main damage a deep reorg would do.

Still open (genuine remaining work): eclipse-resistant peer sampling (today "in sync?" trusts
your current peers, so controlling all of a node's connections can still feed it a fabricated
chain), and anchor-level equivocation slashing.

The UI: deploy a coin, see per-coin balances, list a unique item or an amount of a coin
(priced in any coin or open-to-bids), browse/filter listings, bid, and settle/cancel your own.

### Durable, selective storage

The ledger is held in RAM, but accepted writes are also persisted to a local
**Holepunch `hypercore`** store (one append-only core per writer). On boot the daemon
**replays the store into the ledger** before going live, so state survives a full restart —
not just "as long as some peer stays up."

Persistence is **selective** — you save only what you care about:

- `GAVL_PERSIST=all` (default) — archiver, keep every write (full node). The network needs some of these.
- `GAVL_PERSIST=mine` — keep only writes touching your wallet keys and their coins/auctions; everything else stays RAM-only and is dropped on restart, making your node a *partial node by choice*.
- `GAVL_PERSIST=off` — in-memory only (writes lost on restart).

> Pruning makes **your** node partial; the network only stays whole if some nodes archive.

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
- **P3 — the auction house** ✅ coin-agnostic: user-deployed coins (`coin.deploy`), `transfer`, and `auction.create/bid/settle/cancel` selling items *or* coin amounts, priced in any coin; escrow + per-token conservation + seller-authority; runs live across the mesh
- **Web UI** ✅ Svelte SPA + localhost daemon/API: deploy coins, multi-account wallet, create listings, bid, settle (`npm run daemon` + `npm run web:dev`)
- **Consensus is live** ✅ anchors gossip over the mesh + a producer farms them (`demo:consensus`)
- **Real proofs by default** ✅ chiavdf (proof of time) is the **default** cooldown via `defaultParams()` (async eval so gossip never blocks); chiapos (proof of space) secures anchors; both run live in `demo:consensus`
- **Reorg hardening** ✅ difficulty-as-pace (deterministic retarget, weight ∝ VDF work); real chiapos space backend (`GAVL_SPACE=chiapos`); sticky finality (locked anchors can't be reverted by a heavier fork)
- **P4 — remaining hardening** eclipse-resistant peer sampling; anchor-level equivocation slashing; log/anchor pruning + snapshots; incremental (non-replay) view computation
