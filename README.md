<p align="center">
  <img src="assets/logo.svg" alt="Gavl" width="300" />
</p>

# Gavl

A decentralized **peer-to-peer Bitcoin bull/bear market** on a **Proof-of-Space-Time
cooldown ledger**, built on [Holepunch](https://github.com/holepunchto) (hypercore /
hyperswarm / hyperdht).

Broadcast an intent to go **long** or **short** on Bitcoin; a real peer takes the opposite
side; the two of you escrow against *each other* and settle at the channel's market price.
**There is no pool and no house** — every trade is a matched, zero-sum, fully-collateralized
bet between two people, so reserves can never be drained. When no peer is on the other side, a
**liquidity backstop funded by idle-balance decay** can take it — so the reclaimed gBTC of
squatters becomes the capital that lets someone trade. No servers and no chain to replay from genesis — state lives in
RAM, is **checkpointed into the consensus chain** so a node boots from committed state (a
key-only node can hold nothing but its key and bootstrap from peers), and is bounded by
**cost + decay** rather than hard caps, so it stays small enough for commodity hardware. Every
write pays a **cooldown** (a proof of space *and* a proof of time), so an attacker can't spin
up cheap identities to flood or grind the network.

The price is **named, not voted**: a market is a channel whose name encodes a **Pyth feed**
(`label::pyth::feedId`). Every Pyth price is attested by the Wormhole guardian network, so **anyone
relays** the latest signed update and every node verifies it locally — no reporter to run or trust.
Each channel is its own sandboxed economy. Collateral is **gBTC** — a 1:1 claim on real Bitcoin held
in a **threshold-custody fund** that only a quorum can spend (no single party ever holds the key).

> **Status:** the matched market (consensus + intents + per-channel pricing) is complete and runs live,
> including cross-node intent gossip. The real-BTC bridge runs end-to-end on **testnet** across an
> M-of-N committee — custody is **committee-only** (no single-key path on any network), so the minimum
> deployment is a **3-node** network. Two of the four mainnet gates are now closed (distributed DKG;
> non-public keys); it's still gated on an **independent audit** and **real independent stakers** — see
> [Trust model & status](#trust-model--status). Don't put real mainnet BTC in it yet.

---

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

- **Quality → cooldown.** A proof of space has a *quality*; that quality sets the required
  VDF iterations. More space ⇒ rarer (better) proofs ⇒ fewer iterations ⇒ shorter
  cooldown. (`src/chain/iters.ts`)
- **Infusion.** The VDF runs over a challenge that folds in the proof of space, so a time
  proof is bound to one specific space proof — you can't reuse a VDF.
- **Trunk vs foliage.** The challenge is derived only from chain position
  (`writer, seq, prev, stateRoot`), never the payload, so you can't grind a cheaper
  cooldown by varying what you write. `prev` chains to the previous write's VDF output, so
  future challenges stay unpredictable until the sequential work reveals them.

Real proofs are the default: **chiavdf** (proof of time, async eval so gossip never blocks)
and **chiapos** (proof of space, securing anchors). Set `GAVL_VDF=hash` for a fast stand-in
in tests.

---

## The product — peer-to-peer bull/bear

1. **Deposit** real (testnet) BTC to *your personal* fund address → mint **gBTC** 1:1.
2. **Broadcast an intent** — "long/short *N* gBTC at *L*× leverage" — gossiped over the mesh
   as a signed, non-binding offer; or **take** the opposite side of a peer's resting intent.
3. **A match** escrows both peers' gBTC and opens a bilateral contract, marked to the channel's market.
4. **Close** early any time at the current mark — directional PnL, capped at the stake. A
   position you never close **auto-settles at its time-lock** (a hard ~1-month cap), so nothing
   sits open forever.
5. **Withdraw** — burn gBTC → a quorum threshold-signs and broadcasts a real Bitcoin tx. (Because
   the whole ledger lives in RAM, balances can't sit untouched forever; gBTC left idle too long
   **decays into the liquidity pot**, where it's put to work backing trades instead of squatting.)

### The matched engine (`src/market/intent.ts`, `src/market/btc.ts`)

No pool, no order book to babysit — just signed intents and matched bilateral contracts.

- **Intents are non-binding signed offers.** Broadcasting locks nothing; the offer floods
  the gossip mesh (`sync/`) and rests on every peer's *tape*. Taking one is the only thing
  that hits the consensus ledger.
- **A match is one ledger write** that carries the maker's signed offer. The fold verifies
  the maker signature, checks BOTH peers can cover the stake *right now* (a maker who already
  spent the funds just fails — we verify on-chain anyway), escrows both, and opens the
  contract. No interactive handshake — the signed offer is the authorization.
- **Bilateral, zero-sum, bounded.** Each side stakes the same; settlement splits the
  `2·stake` pot by directional PnL at the channel's mark, capped at the stake. The loser can
  never owe more than it posted. "Leverage" just scales the price move and tightens the cap (at
  *L*×, a `1/L` move against you wipes your stake).
- **A liquidity backstop, funded by idle decay.** With no peer on the other side, the **pot**
  (the idle-decay bucket, see below) can take it — staking matching gBTC as the counterparty
  (`match.pot`). The easy long/short button sweeps resting peer intents first, then falls back to
  the pot for any remainder, so a trade can land even on an empty tape. The pot has PnL like any
  side — winning trades drain idle capital out to traders, losing trades refill it. It can never
  be drawn insolvent: a trade may only stake against pot capital that has *finalized* (a
  network-agreed, deterministic budget), which provably keeps the free pot ≥ 0. It funds only
  what it holds and never mints, so reserves still can't be drained.
- **Partial fills + cross-node.** One offer fills across many takers (tracked by nonce);
  intents propagate epidemically, so a peer on another machine sees your tape and can take it.
- **Time-locked.** Either side may close early at the mark, but every contract has a hard
  lifetime cap and **auto-settles at expiry** against the market — so the open-contract set is
  bounded by throughput, never accumulating positions nobody closes.
- **Idle decay → liquidity (the RAM ledger's bound, turned into a feature).** State lives in RAM,
  so nothing can grow or sit unbounded — including user balances. Rather than cap them, gBTC left
  idle past a ~1-week grace **decays** (−20%/day, hard 1-month cutoff) and is **reappropriated into
  the liquidity pot** — the very capital the backstop above stakes as a counterparty. So the
  constraint *is* the solution: the funds of people who park and forget become the liquidity that
  lets others trade. Decay is per-balance and base-independent (the cutoff measures from a fixed
  idle-start, not a drifting pointer) and only *moves* gBTC; the pot is just a counter, so every
  node agrees on it.
- **Conservation, proven.** `reserves == free gBTC + bonded + contract escrow + pending + pot`.
  Match/settle/decay/backstop only *move* gBTC between buckets, never mint — tested as a hard
  invariant over random op streams. (`src/market/intent.ts`)

### Pricing — a channel *is* a market (`src/market/btc.ts`, `src/daemon.ts`)

The price isn't voted on — it's **named**. A market channel's name encodes the instrument's price
source, and that string IS the market's public, immutable definition (it hashes to the DHT topic).
Two source kinds, both **M-of-N quorum-signed + relayed by anyone** — the fold verifies a quorum
signature, never the relayer, and no single signer can forge:

- `label::pyth::feedId` — a **Wormhole-attested Pyth feed** (`src/market/pyth.ts`). Every price is
  signed by a 2/3+1 quorum (13-of-19) of the Wormhole guardian set over a Merkle root of all feeds;
  the fold verifies the guardian quorum + Merkle proof *locally* and matches the channel's feed id.
- `label::signed::setHash` — **your own M-of-N Ed25519 signer set** (`src/market/signed-feed.ts`),
  the open generalization of the same idea. The channel commits the set by hash (`signerSetHash`
  binds the member keys *and* the threshold M, the analog of Pyth committing its guardian set by
  index); an update carries the set + member signatures, and the fold requires ≥ M signatures from
  distinct members. A relayer can't swap keys, lower the threshold, double-count, or sub-quorum forge.

Either way:

- **No reporter.** A node posts the latest signed update (`market.report {update}`); the fold
  verifies the quorum and accepts it from **anyone**. There's no reporter to run, bribe, or trust —
  the trust anchor is a fixed public committee (the guardian set, or your committed signer set), a
  weak-subjectivity pin, the same shape as bridge custody trusting its committee.
- **Newer wins, deterministically.** The verified publish-time is the monotonic guard (newer update
  replaces older); the fold never fetches, it only verifies posted bytes, so every node agrees.
- **Stale-feed safe.** A price that stops refreshing past `MARKET_STALE_AFTER` is treated as
  no-price — matching/settling pauses rather than trade on a dead number.
- **Sandboxed by construction.** Because the market is the channel, a malicious market can only
  ever touch *its own* channel's pot/collateral — funds in another channel are unreachable.

**Running a signed set.** `feed-signer.ts` runs the whole set in one process (`--keys a,b,c
--threshold 2`) — fine for a solo operator or demo, but one machine holds every key. For a genuinely
decentralized set, each member runs `feed-member.ts` on its own host with its own key and price
source — it co-signs a proposed reading *only* if the price is within tolerance of what it fetches
**itself** — and one untrusted `feed-aggregator.ts` collects ≥ M agreeing signatures, assembles the
update, and serves it at `GAVL_FEED_URL`. A bad proposal makes members refuse → no quorum → no price;
the aggregator can never forge. (Pyth is exactly this shape: members are guardians, the aggregator
is Hermes, the chain verifies.)

---

## The real-BTC bridge (`src/custody`)

gBTC is a 1:1 claim on Bitcoin in a fund **no single party can spend** — secured by FROST
threshold Schnorr (Taproot-compatible), proven against Bitcoin's own BIP340 verifier.

- **Threshold signing** (`threshold.ts`) — a quorum (min-of-max) produces one valid
  signature for the fund's group key, without anyone reconstructing it.
- **DKG** (`dkg-session.ts`, `dkg-coordinator.ts`) — each node runs its own session and only ever
  holds its OWN share plus the shares addressed to it; the live group key is born distributed across
  independent nodes, none ever holding it whole (validated across 3 machines). (`threshold.ts`'s
  in-process DKG is for tests only.)
- **Taproot binding** (`bitcoin.ts`) — the fund key → a real `bc1p…` / `tb1p…` address; a
  quorum's withdrawal signature is BIP340-valid (verified against the BIP341 test vector).
- **Withdrawal txs** (`btctx.ts`) — build the real BIP-341 sighash from the fund's UTXOs,
  threshold-sign, broadcast (via `@scure/btc-signer`).
- **Bridge ledger** (`bridge.ts`) — deposit → mint gBTC; burn → pending withdrawal →
  settle once the payout confirms. Invariant: `reserves == gBTC outstanding + pending`.
- **Per-identity deposit addresses** (`deposit.ts`) — each user deposits to its *own*
  fund-derived address (a tweak of the fund key by the user's pubkey), so a deposit is
  cryptographically bound to the depositor and can't be front-run/claimed by anyone else.
- **Deposit watcher** (`watcher.ts`, `esplora.ts`) — verifies a real on-chain deposit (via
  Esplora, reorg-safe) before minting; the reverse path broadcasts withdrawals.
- **Proof of reserves** — the daemon polls the fund's real on-chain balance and reconciles
  it against the ledger's reserves, flagging any shortfall (the solvency check a custodial
  bridge must run).

**Committee custody is the ONLY mode** — there is no solo/single-key path on any network. VDF-seeded
committee sampling (PoST-weighted by default; **stake-weighted** when `GAVL_CUSTODY_BONDED=1`),
distributed DKG, threshold signing, and proactive resharing all run over the live mesh, rotating the
share-holders each epoch *without moving the fund address*; **bonding** makes a committee seat cost
stake and **slashing** makes ceremony equivocation cost the bond
(`custody/{committee,epoch,rotation,*-coordinator,ceremony-auth,attestation,bridge,slashing}.ts`).
The genesis DKG has been validated **live across three independent machines** — all agreeing
on one fund key, no node ever holding it whole. A committee needs **≥3 independent farmers** to
form: until then a node holds **no fund key, has no deposit address, and can't mint** — it simply
**waits for peers** (there is no single-signer fallback to drop back to). This makes the minimum
real deployment a complete 3-node network, so testing matches production. A **mainnet safety-lock**
additionally refuses in-memory storage (`GAVL_PERSIST=off`) when `GAVL_BTC_NET=mainnet`: real BTC
must be held by an M-of-N committee on durable disk, never in RAM.

> **Auto-slashing — implemented.** Every node taps the inbound ceremony traffic on its
> sub-swarm (`node.onCeremonyMessage`) and feeds it to an `EquivocationWatcher`
> (`custody/equivocation-watcher.ts`); when a member emits two conflicting signed messages for
> one slot, the daemon auto-submits a `custody.slash` with the two messages as the fraud proof,
> and the fold (`custody/slashing.ts` `equivocationCulprit`) burns the culprit's bond to the
> submitter as a bounty. The watcher does NOT flag legitimate round-2 shares (distinct shares
> to distinct recipients) and fires once per slot. Covered by `test/custody-auto-slash.test.ts`.
> The remaining gap is economic, not code: slashing only bites with **real independent bonded
> stakers** — among one operator's own nodes it's a node slashing itself. See
> `docs/scaling-equal-nodes.md` for where custody sits in the bigger picture.

> **Verifiable encrypted resharing (the "share blob") — opt-in, in soak.** The per-epoch reshare can run
> as a durable, publicly-verifiable artifact instead of a live point-to-point ceremony: each old member
> posts a **signed** contribution *deal* (Feldman commitments + a sub-share sealed to each new member's
> X25519 key), anyone verifies the reshare preserved the fund key **with no secret revealed**, and a
> member recovers its share by reading the blob — so a member that was offline at ceremony time isn't
> stranded. It ships **dormant**: by default it runs only in **shadow** alongside the trusted live
> ceremony, logging `shadow reshare epoch N: … blob ✓ · combine ✓` so you can watch it prove itself at
> zero risk. Set `GAVL_PVSS_RESHARE=1` to make it the real reshare, with the live ceremony as an automatic
> fallback on any failure. `custody/{pvss,enckey,reshare-blob,shadow-reshare}.ts`; design in
> [`docs/pvss-reshare.md`](docs/pvss-reshare.md). Don't enable it on mainnet until it's soak-validated.

---

## Consensus (`src/consensus`)

- **Anchor chain** — PoST-proven head certificates. Heaviest-cumulative-weight fork choice
  + depth finality (a locked anchor can't be reverted by a heavier fork).
- **Anchor-epoch canonical order** — cross-epoch order is bound to PoST weight, not
  timestamps, neutralizing the `ts`-reorder attack.
- **Difficulty as pace** — deterministic retarget so the VDF cost is the cadence; weight ∝
  VDF work.
- **App/consensus split** — `consensus/order.ts` is application-agnostic (it yields the
  PoST-bound ordering); the market fold composes it. Consensus never imports app state.

State sync is epidemic: nodes compare a `stateRoot`, diff-pull what's missing, and join a
hyperdht topic whose name *is* the network identity.

> **State-committed checkpoints — the ledger never replays from 0.** Each anchor commits an
> `appRoot` (`anchor.ts`): a `viewRoot` of the folded application state its parent certified.
> A `k`-deep finalized anchor is therefore a **trustless checkpoint** — honest full nodes
> reject any anchor whose `appRoot` doesn't match the state they fold (`AnchorChain.verifyState`),
> so a checkpoint is as secure as the heaviest chain. On that basis a node:
> - **boots** by loading the last checkpoint and folding only the post-checkpoint writes
>   (`Ledger.seedCheckpoint`), never replaying from genesis;
> - **prunes** history below a checkpoint from RAM and disk (`Ledger.pruneBelow`,
>   `WriteStore.pruneBelow`), so neither grows without bound; and
> - **bootstraps a fresh peer** by serving the committed *state* (a `snapshot` gossip message),
>   which the peer authenticates against the anchor `appRoot` and folds forward — it never
>   receives the pre-checkpoint history.
>
> Writer chains are prunable (a `baseSeq` floor + `baseHeadId` so the next write still links;
> `writer.ts`), the fold is resumable (`computeView({ base })`), and the **anchor chain itself
> is pruned** to a recent suffix below the checkpoint (it's committed in no root, so a node only
> needs enough to verify new anchors). Paired with the **delta-encoded anchor heads** (an anchor
> carries only the writers that *changed*), this is the path to a large equal-node network. A
> *Merkle tree* over heads (light-client inclusion proofs) stays **out of scope** — every node
> here is full and equal. Background: [`docs/scaling-equal-nodes.md`](docs/scaling-equal-nodes.md).

> **Bounded by design — no hard caps.** Every structure that lives in RAM is held in check by
> the same shape: it **costs** something to create (a PoST cooldown, or real gBTC backing) **and
> it decays or expires**. History prunes behind checkpoints; the anchor chain keeps only a recent
> suffix; perps time-lock; idle balances decay (demurrage) into the liquidity pot; stale deposit-claim requests expire
> after a reclaim grace; the gossip offer tape is cover-checked (only offers a maker can back are
> kept) + TTL'd; and the out-of-order write buffer is PoST-gated + decays. So a small node's
> memory is bounded by the **real economy**, not by an attacker's willingness to spam — with no
> arbitrary size limit anywhere. At ~10k active traders that's a phone-class footprint (tens of
> MB); it stays commodity-hardware-friendly into the millions.

> **Durability — no central backstop.** The protocol is the only guarantor: state survives as long
> as **≥1 node keeps a durable copy**, and any peer re-syncs from any other. So real nodes run with
> `GAVL_PERSIST=all` (durable disk) — in-memory (`GAVL_PERSIST=off`) is **dev-only**, and mainnet
> refuses it. The trade-off is deliberate and decentralization-first: if *every* copy is permanently
> destroyed, the custodied BTC is **stranded** (still visible on-chain, but the secret committee
> shares are gone with the nodes) — the accepted cost of having no privileged rescuer.
> [`docs/durability-and-decentralization.md`](docs/durability-and-decentralization.md).

---

## Layout

```
src/
  chain/         per-writer PoST write + quality→iters coupling
  pot/  pos/     proof of time (chiavdf) · proof of space (chiapos) + stand-ins
  ledger/        multi-writer RAM ledger + stateRoot
  consensus/     anchor chain, fork choice, finality, difficulty, canonical order
  sync/          hyperswarm/hyperdht mesh, gossip, peer/bootstrap management
  store/         durable hypercore write store + state snapshots/checkpoints + selective persist policy
  market/        the matched market: intents + bilateral contracts (intent.ts), btc fold, ops, account, price feeds
  custody/       real-BTC bridge: threshold (FROST) · DKG · Taproot · per-identity deposits · tx · ledger · watcher · esplora · verifiable encrypted resharing (pvss/reshare-blob/shadow-reshare)
  daemon.ts      boots ledger + node + store + consensus + Pyth price relay + bridge + intent book
  server.ts      localhost JSON API for the web UI
web/             Svelte SPA — the intent tape + bull/bear trading UI
```

---

## Run

Needs **Node ≥ 23.6** (native TypeScript — no build step). Works on macOS, Linux, and
Windows. No Python needed for the local app (it uses the fast stand-in VDF).

```bash
npm install              # once
npm run dev              # ← starts daemon + web UI together, then open http://localhost:5180
```

`npm run dev` is the zero-setup path: it boots the daemon (fast VDF, price reporting,
local-only) **and** the web UI in one command, cross-platform — no env vars to type.

> **Windows / browser note:** the UI binds IPv6, so open **`http://localhost:5180`**, not
> `http://127.0.0.1:5180`.

Other scripts:

```bash
npm test                 # full suite (~238 tests): consensus, checkpoints, genesis-free adoption, matched market, demurrage, liquidity backstop, intent gossip, per-channel pricing, custody + committee DKG, bonding/slashing + auto-slash, bridge
npm run demo             # PoST cooldown chain — watch space→cooldown
npm run demo:consensus   # two nodes farm + gossip anchors, finalize the same state over a real mesh
npm run daemon           # daemon only (real chiavdf VDF — needs the .venv; see below)
npm run web:dev          # web UI only (expects a daemon on :6440)
```

Tuning env vars (set inline on macOS/Linux; on Windows use `set VAR=…` or `$env:VAR=…`, or
just edit the `daemon:dev` script): `GAVL_VDF=hash|chia` · `GAVL_ORACLE_PUBLISH=1` (this node relays
the channel's Pyth feed; anyone may) · `GAVL_BTC_NET=testnet|signet|mainnet` · `GAVL_PERSIST=all|mine|off` ·
`GAVL_MESH=0` (disable the mesh — runs local-only; on by default) · `GAVL_NETWORK=<channel>` ·
`GAVL_PVSS_RESHARE=1` (opt-in: the verifiable blob-path reshare; default off, shadow-validated first). A
**market** channel is named `label::pyth::feedId` (that name is the market's public definition);
a plain name is a transfers-only channel with no price.
The real chiavdf VDF (`GAVL_VDF=chia`, the daemon's default) needs a Python venv with
`chiavdf`/`chiapos`; `npm run dev` sidesteps this by using `GAVL_VDF=hash`.

**Trade against yourself or a peer.** The market needs two sides, so either flip between two
identities (the account picker, bottom-left) or run a second node on the same channel:
broadcast an intent on one, **take** the opposite side on the other → a matched contract
opens, both sides escrow, and it settles at the channel's mark when either side closes.

**Testnet round-trip:** open the UI → **Fund your test wallet** → send testnet BTC to *your*
deposit address → paste the txid to claim → mint gBTC → broadcast/take an intent → close →
withdraw → process payouts (broadcasts a real testnet BTC tx).

**Run a committee (the genesis DKG).** Custody is committee-only, so to mint or withdraw you need
**≥3 nodes that are actually FARMING.** The committee is sampled from *anchor producers* — a node that
is merely *connected* does not count. Until the committee forms, a lone node has no deposit address and
the UI shows *"custody is still forming."*

**On every machine, run it the same way:**

```bash
npm install
npm run dev          # hash VDF + farming + web UI, on the default BTC-USD channel
```

Do **not** use `npm run daemon` for this — that defaults to the real `chiavdf` VDF, which needs the
Python venv; without it, **farming hangs**: the node connects to the mesh but never produces an anchor,
so it never joins the committee (this is the #1 cause of "3 nodes but the DKG won't fire"). `npm run dev`
uses the fast `hash` VDF and farms out of the box. Leave `GAVL_NETWORK` **unset** so all nodes share the
default channel (its DHT topic is the feed id). To run more than one node on one machine, give each its
own `GAVL_DATA_DIR` **and** `GAVL_PORT`.

**Check each node is producing, not just connected:**

```bash
curl -s localhost:6440/api/state | jq '.consensus | {farming, vdf, tip, peers, topic}'
```

Want: `farming: true`, `vdf: "hash-vdf-v0"`, `tip` climbing, `peers` ≥ 2, and `topic` equal to the feed
id (the UI shows a green **`✓ = coordinate`** under the market id when a node is on the right topic — a
mismatch means it's on older code / a different channel).

**The one number that matters** is in the daemon log: `checkpoint: height N … K writer(s)`. `K` is how
many nodes are *producing anchors* — it must reach your node count. **If `K` stays at `1`, the others are
connected but not farming** (fix their VDF/farming as above). When ≥3 are producing, the genesis DKG runs
automatically: `fundKeyOnChain` populates, the members show `holdsShare: true`, and the Custody panel
flips to *"M-of-N committee."*

> The market itself — intents, matching, demurrage, the liquidity pot — works on a single node; only
> custody (deposit/mint/withdraw) needs the committee.

---

## Trust model & status

What's **trustless**: consensus, ordering, storage (no node is trusted); the matched market
(zero-sum, fully-collateralized, conservation proven — no pool to go insolvent); the
threshold signing (no one holds the fund key).

What's **trusted** (and surfaced honestly in the UI):

- **The market price** — each market channel names a **Pyth feed** in its name. Every price is
  attested by the **Wormhole guardian set** (a fixed public committee) and verified on-chain, so
  there's no reporter to trust — you trust the guardian set (a weak-subjectivity pin), and a
  malicious market is sandboxed to its own channel.
- **The bridge** — gBTC is backed by BTC in an **M-of-N committee fund**: the key is DKG'd across
  independent farmers (no node ever holds it whole), and there is **no single-operator/dev-seed
  path** — a node with too few peers simply has no fund and waits. What's still trusted: the
  committee's honest-majority assumption (bonding raises its capture cost) and a single Esplora
  chain view per node (multi-source is future work).

**Before any mainnet satoshi, four gates — two now closed:**

1. **Independent audit.** — *open; the largest remaining blocker.*
2. **Real distributed DKG** across independent nodes (not in-process). — *DONE: genesis DKG
   validated live across three independent machines, all agreeing on one fund key.*
3. **Bonding + slashing** so the honest-majority assumption is economically enforced. — *code
   complete, incl. the auto-slashing equivocation watcher (`test/custody-auto-slash.test.ts`);
   the gap is economic — it only bites with real independent bonded stakers, not one operator's
   own nodes.*
4. **Non-public keys.** — *DONE: the public dev-seed attestor/fund keys were deleted; minting is
   gated on the on-chain DKG'd group key with no single-key fallback.*

## Roadmap

- **Consensus** ✅ PoST cooldown · RAM ledger + gossip · anchor chain, finality, canonical
  order, difficulty retarget, sticky finality · durable selective storage · live over a
  real hyperdht mesh
- **Bounded RAM / scaling** ✅ state-committed checkpoints (boot from state, never replay from
  0) · history + anchor-chain pruning · key-only peers bootstrap from a committed snapshot ·
  **genesis-free adoption** (a fresh node trusts a recent checkpoint, not the grindable origin) with
  a **multi-peer quorum** so no lone peer can feed a fake floor ([weak-subjectivity](docs/weak-subjectivity.md)) ·
  delta-encoded anchor heads · every structure bounded by cost + decay (no hard caps)
- **Peer-to-peer matched market** ✅ signed intents gossiped over the mesh · matched
  bilateral contracts · zero-sum, fully-collateralized, **no pool** (reserves can't be
  drained) · bounded leverage · marked to the channel's market · close-early **+ time-locked
  auto-settle** · idle-balance **demurrage** → **liquidity backstop** (pot as counterparty of last
  resort) · cross-node intent tape · Svelte tape/trade UI
- **Pricing** ✅ **a channel is a market** — the channel name encodes the price source: a **Pyth feed**
  (13-of-19 guardians) or **your own M-of-N Ed25519 signer set**; every price is quorum-signed and
  verified on-chain, so anyone relays it, there's **no reporter**, and no single signer can forge ·
  decentralized signer tooling (independent members + untrusted aggregator) · sandboxed per channel
  (no shared pot, no registry) · newer-publish-time wins · stale-feed pause
- **Real-BTC bridge (testnet)** ✅ FROST threshold signing · DKG · Taproot address +
  BIP340-valid spends · withdrawal tx build/sign/broadcast · deposit watcher · bridge
  ledger · proof of reserves
- **Threshold custody (committee)** ✅ **committee-only** — no single-key path on any network ·
  VDF-sampled committee, per-epoch reshare **without moving the address** · live **3-machine genesis
  DKG** · bonding + (opt-in) stake-weighted selection · slashing + **auto-slashing** equivocation
  watcher · mainnet safety-lock (refuses in-memory) · a lone node holds no key and waits for ≥3 peers ·
  **verifiable encrypted resharing** (the durable "share blob" — opt-in `GAVL_PVSS_RESHARE`, in soak)
- **Mainnet** ⛔ two gates closed (distributed DKG · non-public keys); still gated on an
  **independent audit** and **real independent bonded stakers** — bonding/slashing is code-complete
  but only bites when the stakers aren't all one operator
