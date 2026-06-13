# Scaling plan — the equal-node model

> Status: **plan, not built.** None of this is needed for the current small-network test
> (2 nodes works today). This is the roadmap for growing the network while keeping every
> node equal. Written 2026-06-12.

## Design stance (the constraint we're optimizing under)

- **All nodes equal.** Every node is a full node, full replication — it holds all active
  state and verifies everything. **No light clients.**
- **Commodity hardware.** Anyone can run a node on a normal machine — that's the point of
  decentralization, not just "equal in software."
- **Committee as decentralized as possible** — large, rotated, open to anyone.

This is a deliberate trilemma choice: **decentralization + equality over raw throughput**
(the Bitcoin/Monero ethos — keep nodes cheap so everyone runs one, accept a throughput
ceiling). The rest of this doc takes that as fixed and asks: how far can it scale, and
which levers help *without* breaking equality.

## The iron law this stance buys into

With full replication, **node count and throughput are decoupled:**

- **Number of nodes can be huge** — pure decentralization/resilience. ✅ Fine.
- **Throughput (active trades/sec) is capped at what ONE equal node can handle, and does
  NOT grow as you add nodes.** More nodes = more replicas doing the same work, not more
  capacity. (Only sharding makes throughput scale with nodes, and it breaks "every node
  has all context" — excluded here.)

So "1M nodes" splits in two:
- 1M nodes *participating / watching* → achievable.
- 1M nodes *all actively trading* → **not** achievable on equal commodity hardware. 1M ×
  1 trade/min ≈ 16k writes/sec, and *every* node must verify 16k PoST proofs/sec. That's
  not a commodity machine. This is the price of "everyone equal, everyone full," not a bug.

## Realistic ceiling under this model

First wall is **CPU: verifying every write's PoST proof** (chiavdf/chiapos verify is
milliseconds, not microseconds), then bandwidth, then state.

- Commodity node sustains ~hundreds–low-thousands of write-verifications/sec.
- → **~tens of thousands of sustained active writers** (more if they trade less often),
  plus far more idle/occasional participants (their heads can be GC'd).
- State at that scale (~tens of thousands × a few hundred bytes) ≈ tens of MB — comfortable.
  Bandwidth ≈ single-digit Mbps — comfortable. **CPU/throughput binds first.**

Target to design for: **~tens of thousands of active writers, many more total equal nodes.**

## Current walls (where the code is today)

| Wall | Where | Cost |
|---|---|---|
| Anchor embeds full heads map | `consensus/anchor.ts` `heads: Heads` | ~150 B/writer → ~150 MB at 1M writers |
| All writes kept in RAM, no pruning | `ledger/ledger.ts` `allWrites()` | O(lifetime writes) — snowball |
| Intent gossip floods everyone + full book on connect | `sync/node.ts` intent handlers | O(N²) bandwidth |
| `hello` sync carries full heads | `sync/node.ts:61` | O(writers) per connection |
| Per-write PoST verify | everywhere writes are ingested | **the throughput cap** |

## Levers that preserve equality (priority order)

### 1. Delta-encoded anchors — the core change (this is the "Merkle root" ask, re-scoped)

Stop embedding the full heads map in every anchor.

- Anchor carries `headsRoot` (a hash of the full heads — the existing flat `rootOfHeads`
  is fine) **+ `headsDelta`** (only the writers whose head changed since the previous
  anchor — O(active-per-anchor), tiny).
- Each full node keeps a **running heads map**, applies the delta, recomputes the root,
  and rejects the anchor if it ≠ the committed `headsRoot`.
- **Anchor size: O(total writers) → O(writers-changed-per-anchor).** Most accounts are
  idle in any ~60s window (and PoST cooldown rate-limits everyone), so the delta is
  1–0.1% of the writer set → **~100–1000× smaller anchors** at scale (150 MB → ~100s KB
  at 1M writers).

**Important reframe given "no light clients":** a *Merkle tree* (with inclusion proofs) is
**not** needed for this goal. Inclusion proofs only buy you light-client verification —
which we've excluded. So keep the simple flat root and just delta-encode the data. The
Merkle tree is a **deferred option**, only worth it if a lighter verification path is ever
wanted (cross-shard, audit tooling, etc.).

Under the equal-node stance, the value of this change is **decentralization, not
throughput**: small anchors mean a *larger set of equal commodity nodes* can all keep up
with anchor gossip, and the writer set can grow without the anchor exploding.

Blast radius / files:
- `consensus/anchor.ts` — body: drop embedded `heads`, keep `headsRoot`, add `headsDelta`;
  `mineAnchor` emits the delta; `verifyAnchor` no longer self-checks an embedded map (see
  crux below).
- `consensus/chain.ts` — `AnchorChain` becomes stateful re: heads: maintain running heads
  for the tip (apply deltas, verify root), and **roll back cleanly on reorg** (rebuild
  heads for the new tip's ancestry). `finalizedHeads(k)` returns the reconstructed map.
- `consensus/order.ts` — `finalizedOrdering`/`epochOf` read per-anchor heads from the
  reconstructed running store instead of `anchor.heads`. **Hardest consumer** — the
  finalized fold must stay byte-identical across nodes.
- `sync/node.ts` + `sync/messages.ts` — `anchor-chain` messages shrink (carry deltas, not
  full heads); add a one-time **heads snapshot** request for bootstrap (verified against
  the finalized anchor's root).
- `consensus/producer.ts` — emit the delta alongside the root (already has `ledger.heads()`).
- `market/btc.ts`/daemon — `finalizedView` rides `finalizedOrdering`, inherits the change
  if ordering stays correct.

**Crux:** `epochOf` needs each anchor's *certified* heads (not derivable from writes alone
— a producer certifies the snapshot *it* had). Solved by the running-heads-via-deltas
store + a verified bootstrap snapshot. The trickiest re-architecture is moving the
heads-root check from stateless `verifyAnchor` into the chain/node layer (verify the
committed root against the node's reconstructed heads). Design this before coding.

**Consensus-breaking:** anchor body changes → anchor ids change → all nodes upgrade
together + wipe `~/.gavl/store`. Free pre-launch; bump a chain/version tag.

### 2. History pruning + snapshots — longevity on commodity hardware

Matters *more* under the equal-node stance, because every node must stay commodity-viable
forever, not just at boot.

- Hold **active state + recent writes + periodic snapshots**; drop old writes (no genesis
  replay is already the design — this finishes it).
- Per-node RAM: O(lifetime) → **O(active state)**.
- **GC inactive / zero-balance / no-position / no-bond accounts** — drop their heads too,
  so the heads-set is O(*active* writers), not O(*ever-written*).
- Files: `ledger` (prune below a snapshot height), `store/policy`, a snapshot format,
  bootstrap-from-snapshot path. Listed as remaining (≈P4) in project notes.

### 3. Cheaper / batched PoST verification — the ONLY throughput lever

The per-node verify rate is the throughput ceiling **for every node equally**, so lowering
it raises the active-trader ceiling without giving up equality.

- Options: batch/aggregate proof verification, cheaper proof params, parallel verify across
  cores, caching verified writes.
- This is where extra active-trader headroom comes from if tens-of-thousands isn't enough.

### 4. Market-scoped intent gossip — optional, kills the O(N²) flood

- Each node subscribes only to the instruments / price-bands it trades; offers gossip
  within scope instead of to everyone.
- **Preserves equality** — every node is still a full node; it just doesn't subscribe to
  markets it doesn't care about. Intents are ephemeral (TTL) and non-consensus, so this is
  safe and doesn't touch the ledger.
- Skip only if you insist every node literally sees every resting offer.

## Committee — "as decentralized as possible"

A threshold ceremony (DKG/sign/reshare) is O(n)–O(n²) in messages, so it **cannot** run
among a million nodes — the committee is inherently a bounded subset. Maximize
decentralization three ways (two already built):

1. **Rotation** (built) — fresh committee each epoch, so over time *many* nodes serve.
2. **Open, stake-weighted entry** (built — bonding) — anyone bonded + farming can be
   sampled; permissionless.
3. **Push committee `size`** (the knob) as large as the ceremony stays performant — e.g.
   5 → 30–50 is more decentralized per-epoch at higher ceremony cost. Beyond ~tens, the
   DKG/sign rounds get slow; that's the practical ceiling.

You can't have "all million sign every withdrawal," but rotation gives you "all million are
*eligible* and *take turns*" — the decentralized spirit of it.

## Explicitly OUT (and why)

- **Light clients** — excluded by the equal-node stance. (Would give O(1)-per-client cost
  and the only real path to millions-actively-trading, but breaks "all equal." This is the
  conscious trade.)
- **Sharding** — would make throughput scale with node count, but breaks "every node has
  all context." Excluded.

## Quantified expectations

| | Today | After delta anchors | After + pruning |
|---|---|---|---|
| Anchor size @ 1M writers | ~150 MB | ~100s KB (100–1000×) | same |
| Per-node RAM | O(lifetime writes) | O(lifetime writes) | **O(active state)** (~tens of MB at tens-of-thousands active) |
| Equal-node count supported | low (anchor-bound) | large (anchor no longer the wall) | large + durable |
| Active-trader throughput | ~thousands | ~tens of thousands (verify-bound) | ~tens of thousands (verify-bound) |

Throughput only rises further with lever #3 (cheaper verification). Node *count* rises with
#1 + #2. Equality is preserved throughout.

## Suggested sequencing

- **Phase A — delta anchors** (#1): biggest structural win; lets a much larger equal node
  set keep up. Consensus-breaking → coordinate + reset testnet.
- **Phase B — pruning + snapshots** (#2): longevity on commodity hardware.
- **Phase C — verification throughput** (#3): raise the active-trader ceiling.
- **Phase D — intent scoping** (#4): optional; kill the O(N²) offer flood.
- **Committee `size`**: a config knob, bump anytime within ceremony-performance limits.

## One-line summary

Keep every node equal and commodity → accept ~tens of thousands of *active* traders (CPU /
verify-bound) with *many more* total nodes. Delta-encoded anchors + pruning keep that large
equal node set healthy and durable; cheaper verification is the only way to lift the active
ceiling without abandoning equality. Light clients and sharding — the paths to millions
actively trading — are deliberately off the table.
