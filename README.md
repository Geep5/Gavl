<p align="center">
  <img src="assets/logo.svg" alt="Gavl" width="300" />
</p>

# Gavl

A decentralized **1-click Bitcoin bull/bear market** on a **Proof-of-Space-Time cooldown
ledger**, networked over [I2P](https://geti2p.net) (garlic-routed streams; node IPs stay hidden).

Pick **UP** or **DOWN** on Bitcoin for the next 15-minute round — parimutuel rounds priced by the
Pyth-signed BTC feed. Winners split the losing pool pro-rata — **all of it**: pure parimutuel, no
rake. **There is no pool counterparty and no house** — every stake is real escrowed gBTC and the
pools only ever redistribute it, so reserves can never be drained. PoST is the clock and the
doorman: rounds are derived from anchor height, and every entry pays a cooldown (a proof of space
*and* of time), so an attacker can't spin up cheap identities to flood the network. State lives in
**RAM** and is **checkpointed into the consensus chain**, so a node boots from committed state
(never replaying from genesis).

Collateral is **gBTC** — a 1:1 claim on real Bitcoin held in a **threshold-custody fund** that only
an M-of-N committee can spend (no single party ever holds the key).

> [!WARNING]
> **Gavl is use-it-or-lose-it — not a savings account.** gBTC is meant to be *working*: staked in a
> round or actively moving. A **free balance left idle for 7 days is swept whole** into
> the shared liquidity pot. Rounds run on their own 15-minute clock too — nothing here is
> set-and-forget. **Only keep money in while you're actively using it, and withdraw what you're done
> with.** That bound is what keeps the system spam-proof and RAM-light — it is deliberately *not* a
> place to park BTC.

> **Status:** Gavl Rounds runs live; the real-BTC bridge runs end-to-end on **testnet** across
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

### Gavl Rounds (`src/market/rounds.ts`)

The 1-click bull/bear: **parimutuel up/down rounds derived from anchor height** — no scheduler, no
listing op, no order book. Round *N* IS the height interval `[N·15, (N+1)·15)`:

1. **Deposit** testnet BTC to *your* fund address → mint **gBTC** 1:1.
2. **Enter** — while a round's window is open, anyone stakes gBTC on **UP** or **DOWN** (one write:
   `round.enter`). Entries close one anchor before lock, so there's no last-second info sniping.
3. **Lock / strike** — at the window's end the round locks; the strike is the first *confidence-OK*
   oracle write at or after the boundary ("the first qualifying write in fold order", so full and
   checkpoint-resumed nodes can never disagree). A wide-confidence Pyth update is skipped and the
   next one is tried — the "clear photo" gate.
4. **Close / settle** — one window later, the same rule sets the close. Winners split the losing
   pool **pro-rata to stake** — **100% of it** (pure parimutuel, no rake; only integer-division dust
   reaches the liquidity pot); the round deletes itself.

**Full round?** Admission is **top-N-by-stake**: a full round admits only a strictly-bigger stake,
evicting (and refunding) the floor entry — squatting a slot costs real capital; ties keep the
incumbent. **Refund edges:** a tie (close == strike), a one-sided round, or an oracle that never
produces a qualifying strike/close (dark past a timeout) refunds every entry its stake — nobody can
lose to a market that didn't happen. The liquidity pot is an **idle-decay reservoir**: it is fed by
the **idle-balance sweep** (demurrage), and its one outflow is **pot-seeding** — at lock it stakes
the thin side of an imbalanced round (budget-capped), so what idle balances forfeit makes thin
rounds settleable. Conservation is a tested invariant:
`reserves == free + bonded + pending + pot + rounds` — ops only *move* gBTC, never mint.

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

#### Genesis committee — a deliberate testnet/mainnet split (a tradeoff, *not* a bug)

The genesis DKG above is the secure path, but it is a **live multi-node ceremony** that must complete on
the wire before custody works — and it is brittle to bootstrap: it is *n-of-n* for key generation, so a
single non-completing member **wedges it**. That is a real failure mode you hit *regardless* of how clean
the mesh is. So for **testnet/dev** we sidestep the live ceremony with a **trusted-dealer setup** that keeps
the repo clean:

1. `npm run committee:setup` mints a 2-of-3 committee **once, on one machine, with fresh randomness**, prints
   the **public group key**, and writes one secret bundle per seat (its share + committee keypair).
2. You paste **only the public group key** into [`genesis-committee.ts`](src/custody/genesis-committee.ts)
   (or set `GAVL_COMMITTEE_PUBKEY`), and copy each seat bundle into that node's `<data>/custody/`
   **out-of-band — the secret shares never touch git.**
3. On boot a node loads its share, **verifies it against the repo's public key** (refusing a mismatch),
   announces the key into consensus state, and signs. No DKG, nothing to wedge.

A fresh clone of the repo has the fund **address and no way to spend** — a public key can't sign and can't be
reversed into the private key. The secret shares live only on the nodes.

**The tradeoff, and why it is testnet-only:** the machine that runs the one-time setup transiently sees the
whole key while it cuts the shares (a "trusted dealer"). You delete the output afterward and trust that
one-time setup — a standard trusted-setup assumption, fine for an operator standing up their own nodes, but
*not* trustless. **Mainnet keeps the live distributed DKG**, where no machine ever sees the whole key; the
daemon gates the trusted-dealer path off mainnet.

**This split is intentional — do not "fix" it by deleting one side.** The trusted-dealer setup unblocks
dev/testnet without a flaky ceremony; the live DKG is the trustless production path. Its bootstrap-robustness
(timeout-and-exclude / qualified-set, so one bad member can't wedge it) is a *separate, tracked* concern.

### Consensus + bounded RAM (`src/consensus/`)

A permissionless **anchor chain** of PoST-proven head certificates linearizes the multi-writer logs:
heaviest-cumulative-weight fork choice with depth-`k` finality, difficulty retarget so the VDF cost
is the pace. Each anchor commits an `appRoot` (a root of the folded state its parent certified), so a
`k`-deep finalized anchor is a **trustless checkpoint**: a node boots by loading the last checkpoint
and folding only the writes above it, prunes history below it from RAM, and bootstraps fresh peers by
serving committed *state* rather than history. Everything that lives in RAM is bounded the same way —
it costs something to create and it decays or expires — so a node's footprint is bounded by the real
economy, not by spam. (`docs/` has the detail: weak-subjectivity, durability, scaling.)

### Networking — I2P (`src/sync/`)

Gossip rides [I2P](https://geti2p.net): every peer link is a **garlic-routed stream** through a
local I2P router, spoken **natively from the daemon** via the router's SAM v3 bridge — no sidecar
process, no hub, and node IPs are hidden from each other and from observers (which raises the
capture cost of the custody committee). A Gavl sync frame is one JSON line on the stream; bulk
transfers (anchor-chain pulls, checkpoint snapshots) are just bytes on a reliable stream.

Discovery is **seeds + peer exchange**: dial one known peer (`GAVL_I2P_PEERS`, or the UI's dial
box) and the mesh gossips the rest transitively. Every stream handshake carries a **signed
producer↔address binding**, so any node can address a consensus-roster member directly. The mesh
is **bounded** (`GAVL_MAX_PEERS`, default 16) so per-node space stays manageable at any network
size; committee members are linked directly via their bindings. A node's stable address is its
**b32** (printed at boot and shown in the UI's Network panel — share it once with a peer and
you're meshed).

Sync is epidemic: nodes compare a `stateRoot`, diff-pull what's missing, and re-advertise when they
learn something. Offline catch-up is the **checkpoint bootstrap** (a rejoining node adopts the
network's finalized checkpoint and pulls committed state, never a message backlog).

---

## Run

Needs **Node ≥ 23.6** (native TypeScript — no build step), **Python ≥ 3.9** (real PoST only), and a
local **I2P router with SAM** (i2pd is lightest). Works on macOS, Linux, Windows.

```bash
npm install              # once
brew install i2pd && brew services start i2pd    # once — the I2P router (SAM is on by default)
                                                 #   Linux: apt install i2pd && systemctl start i2pd
npm run setup:chia       # once — venv + chiavdf/chiapos (prebuilt wheels; no C++ toolchain)
npm run dev              # real-PoST daemon + web UI, then open http://localhost:5180
```

`npm run dev` runs **real Proof-of-Space-Time** (chiavdf + chiapos) over **I2P**, plus price relay
and the web UI. No Python for the proofs? `npm run dev:hash` swaps in the fast stand-ins
(`GAVL_VDF=hash GAVL_SPACE=standin`) — it still networks over I2P, so it still needs the router.

A fresh router **reseeds** into the I2P network on first start — give it a couple of minutes
before the first `npm run dev`. The daemon fails fast and loud if the SAM port (default
`127.0.0.1:7656`; `GAVL_SAM_HOST`/`GAVL_SAM_PORT`) doesn't answer.

> **Windows / browser:** open `http://localhost:5180` (the UI binds IPv6), not `127.0.0.1`.

### Multi-node (the committee)

Custody needs **≥3 nodes actually FARMING** (a merely-connected node doesn't count). On every machine:

```bash
npm install && npm run setup:chia
npm run dev          # all nodes must use the SAME backend (all real-PoST or all dev:hash, never mixed)
```

Leave `GAVL_NETWORK` unset so all nodes share the default `BTC-USD` channel. **Mesh them once**:
each node prints its i2p **b32 address** at boot (also in the UI's Network panel) — on one node,
dial any other via the UI's dial box or `GAVL_I2P_PEERS=<b32>`, and peer exchange gossips the rest
(dialed peers are pinned + re-dialed every boot). To run more than one node on one machine, give
each its own `GAVL_DATA_DIR` **and** `GAVL_PORT` (they share the one local router). Watch the
daemon log for `checkpoint: height N … K writer(s)` — `K` is how many nodes are *producing anchors*
and must reach your node count; when ≥3 produce, the genesis DKG runs and the Custody panel flips
to "M-of-N committee."

Verify a node is really farming:

```bash
curl -s localhost:6440/api/state | jq '.consensus | {farming, vdf, space, tip, peers, transport}'
```

Want `farming: true`, `vdf: "chiavdf-wesolowski-1024"` + `space: "chiapos"` (real PoST; stand-ins show
`hash-vdf-v0` / `standin`), `tip` climbing, and `peers` ≥ 2.

There is no hub and no rendezvous server to run: each node's router participates in the global I2P
network, and Gavl peers find each other via the seed you dial plus peer exchange. The only
"infrastructure" is one locally-running i2pd per machine.

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
transfers-only) · `GAVL_I2P_PEERS=<b32,b32,…>` (seed peers to dial at boot) · `GAVL_SAM_HOST` /
`GAVL_SAM_PORT` (the local router's SAM bridge; default `127.0.0.1:7656`) ·
`GAVL_PEX_INTERVAL=<seconds>` (peer-exchange/redial cadence; default 15). Real PoST needs the `setup:chia` venv; choosing `GAVL_VDF=chia` without it throws
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
  sync/          I2P (SAM v3) transport · gossip · bounded mesh · signed producer↔address bindings
  store/         durable write store (node:sqlite) + state snapshots/checkpoints + selective persist policy
  market/        Gavl Rounds (parimutuel bull/bear), btc fold, account, Pyth/signed price feeds
  custody/       real-BTC bridge: FROST threshold · DKG · Taproot · deposits · tx · watcher · reshare
  daemon.ts      boots ledger + node + store + consensus + price relay + bridge
  server.ts      localhost JSON API for the web UI
web/             Svelte SPA — the 1-click bull/bear rounds UI
```

---

## Trust model

**Trustless:** consensus, ordering, storage; the rounds market (parimutuel, fully-collateralized,
conservation proven); threshold signing (no one holds the fund key).

**Trusted (surfaced in the UI):** the channel's **price committee** (the Wormhole guardian set for a
Pyth feed, or your own committed Ed25519 set — a fixed public committee, not a reporter), and the
**bridge committee's honest-majority assumption** (bonding raises its capture cost) plus a single
Esplora chain view per node. A malicious market is sandboxed to its own channel.

Before any mainnet satoshi: an **independent audit** (the largest open blocker) and **real
independent bonded stakers** (slashing only bites when the stakers aren't all one operator).
Distributed DKG and non-public keys are already done. Until then it's testnet-only.

## TODO / not yet built

Tracked custody gaps — listed so they aren't rediscovered or "fixed" by accident:

- [x] **Genesis-committee verify guard** (testnet committee) — *done*. A node refuses an on-disk share whose
  group key doesn't equal the repo's hardcoded public key, so it won't run a committee that disagrees with the
  public identity. Built alongside the trusted-dealer setup (which replaced the old seed-derived committee —
  the seed is gone, so the repo carries no secret). [`src/custody/genesis-committee.ts`](src/custody/genesis-committee.ts).
- [ ] **Live-DKG bootstrap robustness** (mainnet committee). The genesis DKG is *n-of-n*, so one
  non-completing member wedges it; add timeout-and-exclude / a qualified-set so the committee forms among
  the responsive ≥threshold members and a stale node can't block it. The dev committee sidesteps this for
  testnet; mainnet still needs it.
- [ ] **Autonomous signing trigger** (custody ops). Each seat must independently detect a
  deposit/withdrawal and join the 2-of-3 signing round; coordinating *when* to sign is the piece to
  finish before real BTC moves in or out.
