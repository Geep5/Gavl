<p align="center">
  <img src="assets/logo.svg" alt="Gavl" width="300" />
</p>

# Gavl

A decentralized **peer-to-peer Bitcoin bull/bear market** on a **Proof-of-Space-Time cooldown
ledger**, networked over the [Reticulum](https://reticulum.network) stack.

Broadcast an intent to go **long** or **short** on Bitcoin; a real peer takes the opposite side; the
two of you escrow against *each other* and settle at the channel's market price. **There is no pool
and no house** — every trade is a matched, zero-sum, fully-collateralized bet between two people, so
reserves can never be drained. State lives in **RAM**, is **checkpointed into the consensus chain**
so a node boots from committed state (never replaying from genesis), and is bounded by **cost +
decay** rather than hard caps. Every write pays a **cooldown** (a proof of space *and* of time), so
an attacker can't spin up cheap identities to flood the network.

Collateral is **gBTC** — a 1:1 claim on real Bitcoin held in a **threshold-custody fund** that only
an M-of-N committee can spend (no single party ever holds the key).

> **Status:** the matched market runs live; the real-BTC bridge runs end-to-end on **testnet** across
> a 3-node committee. Custody is committee-only (no single-key path on any network). Still gated on an
> independent audit + real independent stakers — **don't put real mainnet BTC in it.**

---

## How it works

### Proof-of-Space-Time cooldown

Every write pays a cooldown bound to two scarce resources, so neither sybils nor faster hardware help:

| Proof | Scarce resource | Stops |
|---|---|---|
| **Space** (chiapos plot) | disk per identity | sybil — more nodes now costs more disk |
| **Time** (chiavdf VDF) | sequential compute | grinding — more machines don't write faster |

A proof of space has a *quality* that sets the required VDF iterations (more space ⇒ shorter
cooldown), and the VDF is infused with the space proof so a time proof can't be reused. Each write
carries both proofs + an Ed25519 signature and **verifies in isolation** — no ancestry walk — which
is what makes "verify against your current peers" cheap and a RAM chain with no genesis replay
possible. Real PoST (chiavdf + chiapos) is the default; `GAVL_VDF=hash GAVL_SPACE=standin` is a fast
stand-in for tests/UI work.

### Matched Directional Swaps (`src/market/`)

A fully-collateralized, zero-sum, **bounded** bet on Bitcoin's direction between two peers:

1. **Deposit** testnet BTC to *your* fund address → mint **gBTC** 1:1.
2. **Broadcast an intent** — "long/short *N* gBTC at *L*×" — gossiped as a signed, non-binding offer;
   or **take** the opposite side of a peer's resting intent.
3. **A match** is one ledger write carrying the maker's signed offer. The fold verifies the
   signature, checks both sides can cover the stake, escrows both, and opens a bilateral contract.
4. **Settle** by splitting the `2·stake` pot by directional PnL, each payout capped to `[0, 2·stake]`
   — the loser never owes more than its stake. Either side may **close early** at the mark; an open
   position **auto-settles at a ~1-month time-lock**. No funding rate, no liquidation, no house.

When no peer is on the other side, a **liquidity backstop** takes it, staked from the **idle-decay
pot**: gBTC left idle past a grace period decays into the pot (the RAM ledger's bound turned into a
feature), and that reclaimed capital is what lets others trade. Conservation is a tested invariant:
`reserves == free + bonded + escrow + pending + pot` — ops only *move* gBTC, never mint.

### Pricing — named, not voted (`src/market/pyth.ts`)

A market is a channel whose name encodes its price source: `label::pyth::feedId`. Every **Pyth** price
is signed by a 2/3+1 quorum (13-of-19) of the **Wormhole guardian set** over a Merkle root of all
feeds, so **anyone relays** the latest signed update and every node verifies the guardian quorum +
Merkle proof *locally* — there's no reporter to run or trust. The guardian set is a pinned
weak-subjectivity trust anchor (currently **set index 7**); if Wormhole rotates it, refresh
`WORMHOLE_GUARDIANS` from the core bridge's `getGuardianSet(uint32)` on-chain. (A channel can also
name `label::signed::setHash` — your own M-of-N Ed25519 signer set; `src/market/signed-feed.ts`.)

### Real-BTC bridge + committee custody (`src/custody/`)

gBTC is a 1:1 claim on Bitcoin in a fund no single party can spend, secured by **FROST threshold
Schnorr** (Taproot-compatible, BIP340-valid spends). The fund key is **DKG'd across independent
farmers** — each node only ever holds its own share — and the committee **reshares every epoch
without moving the fund address**. Deposits go to per-identity fund-derived addresses (verified
on-chain via Esplora before minting); withdrawals are threshold-signed and broadcast as real BTC
txs. Committee membership is VDF-sampled (PoST-weighted, or stake-weighted with
`GAVL_CUSTODY_BONDED=1`) with bonding + slashing.

Custody is **committee-only**: it needs **≥3 nodes actually farming** to run the genesis DKG. Until
then a node holds no fund key and can't mint — it waits for peers. Mainnet additionally refuses
in-memory storage (`GAVL_PERSIST=off`).

### Consensus + bounded RAM (`src/consensus/`)

A permissionless **anchor chain** of PoST-proven head certificates linearizes the multi-writer logs:
heaviest-cumulative-weight fork choice with depth-`k` finality, difficulty retarget so the VDF cost
is the pace. Each anchor commits an `appRoot` (a root of the folded state its parent certified), so a
`k`-deep finalized anchor is a **trustless checkpoint**: a node boots by loading the last checkpoint
and folding only the writes above it, prunes history below it from RAM, and bootstraps fresh peers by
serving committed *state* rather than history. Everything that lives in RAM is bounded the same way —
it costs something to create and it decays or expires — so a node's footprint is bounded by the real
economy, not by spam. (`docs/` has the detail: weak-subjectivity, durability, scaling.)

### Networking — Reticulum (`src/sync/`)

Gossip rides the [Reticulum](https://reticulum.network) stack: every sync frame travels as an **LXMF**
message, gaining **store-and-forward** (offline peers catch up via propagation nodes). Peers discover
each other by **announce** (no rendezvous topic) and learn a **signed producer↔address binding**, so
any node can address a consensus-roster member directly. The mesh is **bounded** (`GAVL_MAX_PEERS`,
default 16) so per-node space stays manageable at any network size; committee members are linked
directly via their bindings. It runs via a small Python sidecar (RNS/LXMF) — see
[`bridge/README.md`](bridge/README.md).

Sync is epidemic: nodes compare a `stateRoot`, diff-pull what's missing, and re-advertise when they
learn something.

---

## Run

Needs **Node ≥ 23.6** (native TypeScript — no build step) and **Python ≥ 3.9** — for the Reticulum
networking sidecar (always), and for real PoST. Works on macOS, Linux, Windows.

```bash
npm install              # once
pip install rns lxmf     # once — the Reticulum (RNS/LXMF) networking sidecar
npm run setup:chia       # once — venv + chiavdf/chiapos (prebuilt wheels; no C++ toolchain)
npm run dev              # real-PoST daemon + web UI, then open http://localhost:5180
```

`npm run dev` runs **real Proof-of-Space-Time** (chiavdf + chiapos) over **Reticulum**, plus price
relay and the web UI. No Python for the proofs? `npm run dev:hash` swaps in the fast stand-ins
(`GAVL_VDF=hash GAVL_SPACE=standin`) — but it still networks over Reticulum, so it needs `rns`/`lxmf`.

Point `GAVL_RNS_CONFIG` at a standalone Reticulum config to run Gavl's own RNS instance with its own
interfaces/hubs; otherwise it uses the system `~/.reticulum`. More in [`bridge/README.md`](bridge/README.md).

> **Windows / browser:** open `http://localhost:5180` (the UI binds IPv6), not `127.0.0.1`.

### Multi-node (the committee)

Custody needs **≥3 nodes actually FARMING** (a merely-connected node doesn't count). On every machine:

```bash
npm install && npm run setup:chia
npm run dev          # all nodes must use the SAME backend (all real-PoST or all dev:hash, never mixed)
```

Leave `GAVL_NETWORK` unset so all nodes share the default `BTC-USD` channel. To run more than one node
on one machine, give each its own `GAVL_DATA_DIR` **and** `GAVL_PORT`. Watch the daemon log for
`checkpoint: height N … K writer(s)` — `K` is how many nodes are *producing anchors* and must reach
your node count; when ≥3 produce, the genesis DKG runs and the Custody panel flips to "M-of-N
committee."

Verify a node is really farming:

```bash
curl -s localhost:6440/api/state | jq '.consensus | {farming, vdf, space, tip, peers, transport}'
```

Want `farming: true`, `vdf: "chiavdf-wesolowski-1024"` + `space: "chiapos"` (real PoST; stand-ins show
`hash-vdf-v0` / `standin`), `tip` climbing, and `peers` ≥ 2.

### Other scripts & env

```bash
npm test                 # full suite
npm run dev:hash         # zero-setup: hash VDF + stand-in space (no venv)
npm run daemon           # real-PoST daemon only (no web UI)
npm run web:dev          # web UI only (expects a daemon on :6440)
```

Key env vars: `GAVL_VDF=chia|hash` · `GAVL_SPACE=chiapos|standin`
· `GAVL_K=<n>` (plot size; default 18 for chiapos) · `GAVL_MAX_PEERS=<n>` (bounded mesh; default 16) ·
`GAVL_PERSIST=all|mine|off` · `GAVL_BTC_NET=testnet|signet|mainnet` · `GAVL_DATA_DIR` / `GAVL_PORT`
(isolate a node) · `GAVL_NETWORK=<channel>` (`label::pyth::feedId` is a market; a plain name is
transfers-only). Real PoST needs the `setup:chia` venv; choosing `GAVL_VDF=chia` without it throws
(never a silent downgrade). Moving a *live* channel from stand-ins to real PoST is a coordinated
upgrade — see [`docs/real-post-cutover.md`](docs/real-post-cutover.md).

---

## Layout

```
src/
  chain/         per-writer PoST write + quality→iters coupling
  pot/  pos/     proof of time (chiavdf) · proof of space (chiapos) + stand-ins
  ledger/        multi-writer RAM ledger + stateRoot
  consensus/     anchor chain, fork choice, finality, difficulty, canonical order
  sync/          Reticulum (LXMF) transport · gossip · bounded mesh · signed producer↔address bindings
  store/         durable write store + state snapshots/checkpoints + selective persist policy
  market/        matched market: intents + bilateral contracts, btc fold, account, Pyth/signed price feeds
  custody/       real-BTC bridge: FROST threshold · DKG · Taproot · deposits · tx · watcher · reshare
  daemon.ts      boots ledger + node + store + consensus + price relay + bridge + intent book
  server.ts      localhost JSON API for the web UI
bridge/          Python Reticulum (RNS/LXMF) networking sidecar (the only transport)
web/             Svelte SPA — the intent tape + bull/bear trading UI
```

---

## Trust model

**Trustless:** consensus, ordering, storage; the matched market (zero-sum, fully-collateralized,
conservation proven); threshold signing (no one holds the fund key).

**Trusted (surfaced in the UI):** the channel's **price committee** (the Wormhole guardian set for a
Pyth feed, or your own committed Ed25519 set — a fixed public committee, not a reporter), and the
**bridge committee's honest-majority assumption** (bonding raises its capture cost) plus a single
Esplora chain view per node. A malicious market is sandboxed to its own channel.

Before any mainnet satoshi: an **independent audit** (the largest open blocker) and **real
independent bonded stakers** (slashing only bites when the stakers aren't all one operator).
Distributed DKG and non-public keys are already done. Until then it's testnet-only.
