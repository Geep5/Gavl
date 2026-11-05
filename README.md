<p align="center">
  <img src="assets/logo.svg" alt="Gavl" width="300" />
</p>

# Gavl

A **decentralized, ephemeral BTC↔LTC atomic-swap order board**, running on a
**Proof-of-Space-Time** (chiapos + chiavdf) anchor chain gossiped over [Nostr](https://nostr.com)
relays (public relays; nothing to install, nothing to host).

Makers post offers, takers accept them, and the two matched parties then swap **directly on-chain**
via Taproot HTLCs. Gavl is only the meeting place: **coins never leave their own chains**, and
nothing about orders or swaps persists on Gavl long-term. Gavl holds no funds — no custody, no
vault, no wrapped tokens. Each user's daemon automates its own swap steps and keeps the swap secrets
on local disk until the swap ends.

> **Status:** the PoST anchor chain, Nostr gossip and the Esplora chain client (`src/chains/`) run
> today. Offer matching and the swap engine (`src/swap/`) are being built. Testnet only.

---

## How it works

### Atomic swaps (Taproot HTLCs)

Each side locks coins on its own chain into a Taproot output with a **NUMS internal key** (no
key-path spend) and two script leaves:

- **claim:** `OP_SHA256 <H> OP_EQUALVERIFY <receiver> OP_CHECKSIG` — the receiver spends by
  revealing the preimage of `H`;
- **refund:** `<n> OP_CSV OP_DROP <sender> OP_CHECKSIG` — the sender takes the coins back after
  `n` blocks.

The **initiator** (who knows the preimage) locks first with the **longer** window, the
**counterparty** locks second with the **shorter** one: 24h / 12h → **BTC 144 / 72 blocks**,
**LTC 576 / 288 blocks**. When the initiator claims the counterparty's output it reveals the
preimage on-chain, which the counterparty then uses to claim the initiator's output. If either
party walks away, both refund after their timeouts.

### Proof-of-Space-Time cooldown

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

### Consensus + bounded RAM (`src/consensus/`)

A permissionless **anchor chain** of PoST-proven head certificates linearizes the multi-writer logs:
heaviest-cumulative-weight fork choice with sticky depth-`k` finality (default 2), difficulty retarget so the VDF cost
is the pace. A branch that abandons a node's locked anchor wins only if producers holding a weighted
majority of the pre-fork window built it exclusively — else, if neither side has that, the heavier
branch wins — so a healed partition converges while a minority's heavier private fork can't revert
what the majority finalized. Beneath that sits **settlement** (depth 6): a settled anchor is never
`/api/state`). Irreversible local actions (checkpoint-pruning history) wait for settlement, never
soft finality. Each anchor commits an `appRoot` (a root of the folded state its parent certified), so a
settled anchor is a **trustless checkpoint**: a node boots by loading the last checkpoint
and folding only the writes above it, prunes history below it from RAM, and bootstraps fresh peers by
serving committed *state* rather than history. Everything that lives in RAM is bounded the same way —
it costs something to create and it decays or expires — so a node's footprint is bounded by real
activity, not by spam. (`docs/` has the detail: weak-subjectivity, durability, scaling.)

### Networking — Nostr (`src/sync/`)

### Networking — Nostr (`src/sync/`)

Gossip rides [Nostr](https://nostr.com): peers exchange **signed ephemeral events through public
relays**, spoken natively from the daemon over plain WebSockets — no sidecar process, no local
router, no hub to host, and **no inbound port**, so a node behind any NAT or firewall just works.
Relays are **untrusted and disposable**: they can withhold or censor, never forge, because every
write carries its own Ed25519 signature + PoST proof and every anchor is verified locally. We
publish to *all* configured relays and treat each as unreliable — measured reality is that some
refuse connections, some gate writes behind a web-of-trust, and some accept a publish and never
forward it. Overlapping on **one** working relay is enough for two nodes to talk.

Discovery is a **relay query**, so there are no seeds and no peer-exchange to bootstrap: every node
publishes a replaceable **presence** event on the channel, so "who is on this network" is a single
subscription. That presence carries a **signed producer↔address binding**, so any node can address
a consensus-roster member directly. The mesh is **bounded** (`GAVL_MAX_PEERS`, default 16);
A node's stable address is its **Nostr pubkey**
(printed at boot and shown in the UI's Network page).

Bulk frames (anchor-chain pulls, checkpoint snapshots) exceed what relays accept (~32 KB in
practice, whatever NIP-11 advertises), so they are **chunked** across events and reassembled
byte-exactly — base64 so a multi-byte character can never be split, with a bounded, TTL'd
reassembly buffer that a hostile peer can't grow (`src/sync/chunk.ts`).

Sync is epidemic: nodes compare a `stateRoot`, diff-pull what's missing, and re-advertise when they
learn something. Offline catch-up is the **checkpoint bootstrap** (a rejoining node adopts the
network's finalized checkpoint and pulls committed state, never a message backlog).

---

## Run

## Run

Needs **Node ≥ 23.6** (native TypeScript — no build step), **Rust** via [rustup](https://rustup.rs)
(the desktop app; on macOS also Xcode) and **Python ≥ 3.9** (real PoST only).
Works on macOS, Linux, Windows. **Nothing to install for networking** — no router, no relay of your
own, no ports to open.

```bash
npm install              # once
npm run setup:chia       # once — venv + chiavdf/chiapos (prebuilt wheels; no C++ toolchain)
npm run dev              # real-PoST daemon + the desktop app
```

`npm run dev` runs **real Proof-of-Space-Time** (chiavdf + chiapos) over **Nostr**, plus the
desktop app (the first launch compiles it, a few minutes). Closing the window leaves the
node running; Ctrl-C stops both. No Python for the proofs? `npm run dev:hash` swaps in the fast
stand-ins (`GAVL_VDF=hash GAVL_SPACE=standin`).

Peers find each other automatically through the shipped default relays; point at your own with
`GAVL_RELAYS=wss://a,wss://b`. The daemon fails fast and loud if it can't reach any relay.


### Desktop app (`desktop/`)

The default UI: a native client for the daemon API, built with [GPUI Kit](https://gpui-kit.com) on
[GPUI Fast](https://github.com/longbridge/gpui-fast). Two pages: **Network · Node**; the network's
health stays in the title bar, and block/peer details sit in the status bar. `npm run desktop`
starts it alone against an already-running daemon (stable Rust, pinned by
`desktop/rust-toolchain.toml`); `GAVL_API=http://host:port` points it at a daemon other than
`http://127.0.0.1:6440`.

## Multi-node

On every machine:

```bash
npm install && npm run setup:chia
npm run dev          # all nodes must use the SAME backend (all real-PoST or all dev:hash, never mixed)
```

Leave `GAVL_NETWORK` unset so all nodes share the default `gavl-testnet` channel. **They mesh
themselves** — each node announces its presence on the channel and discovers the others through the
relays, so there is nothing to dial (a node's Nostr pubkey is printed at boot and shown in the UI's
Network page if you want to pin one explicitly). To run more than one node on one machine, give
each its own `GAVL_DATA_DIR` **and** `GAVL_PORT`. Watch the daemon log for
`checkpoint: height N … K writer(s)` — `K` is how many nodes are *producing anchors*.

Verify a node is really farming:

```bash
curl -s localhost:6440/api/state | jq '.consensus | {farming, vdf, space, tip, peers, transport}'
```

Want `farming: true`, `vdf: "chiavdf-wesolowski-1024"` + `space: "chiapos"` (real PoST; stand-ins show
`hash-vdf-v0` / `standin`), `tip` climbing, and `peers` ≥ 1.

There is no hub, no rendezvous server, and no relay of your own to run: nodes meet on public
relays that already exist. Relays are a **default, not an authority** — swap them freely with
`GAVL_RELAYS`, and two nodes only need one relay in common.

### Other scripts & env

```bash
npm test                 # full suite
npm run regtest:install  # once — installs the local regtest tooling
npm run test:regtest     # end-to-end tests against local regtest chains
npm run dev:hash         # zero-setup: hash VDF + stand-in space (no venv)
npm run daemon           # real-PoST daemon only (no UI)
npm run daemon:hash      # daemon with the fast stand-ins
npm run daemon:fresh     # stand-ins, in-memory (GAVL_PERSIST=off) — a throwaway node
npm run desktop          # desktop app only (expects a daemon on :6440)
```

Key env vars: `GAVL_VDF=chia|hash` · `GAVL_SPACE=chiapos|standin`
· `GAVL_K=<n>` (plot size; default 18 for chiapos) · `GAVL_MAX_PEERS=<n>` (bounded mesh; default 16) ·
`GAVL_PERSIST=all|mine|off` · `GAVL_DATA_DIR` / `GAVL_PORT` (isolate a node) ·
`GAVL_NETWORK=<label>` (channel name; default `gavl-testnet`) ·
`GAVL_RELAYS=<wss://…,wss://…>` (override the default relay set) ·
`GAVL_ANNOUNCE_INTERVAL=<seconds>` (presence refresh cadence; default 30) ·
`GAVL_REPLICATION_TARGET=<n>` (warn when the latest checkpoint has fewer holders; see
[`docs/replication-floor.md`](docs/replication-floor.md)).

Swap chains (`src/chains/esplora.ts`): `GAVL_BTC_NET` / `GAVL_LTC_NET` = `mainnet|testnet|regtest`
(default `testnet`; mainnet is never selected implicitly) · `GAVL_BTC_ESPLORA_URL` /
`GAVL_LTC_ESPLORA_URL` = comma-separated Esplora REST bases, tried in order (defaults:
mempool.space + blockstream.info for BTC, litecoinspace.org for LTC; **regtest has no default and
needs an override**).

Real PoST needs the `setup:chia` venv; choosing `GAVL_VDF=chia` without it throws (never a silent
downgrade). Moving a *live* channel from stand-ins to real PoST is a coordinated upgrade — see
[`docs/real-post-cutover.md`](docs/real-post-cutover.md).

---

## Layout

```
src/
  chain/         per-writer PoST write + quality→iters coupling
  pot/  pos/     proof of time (chiavdf) · proof of space (chiapos) + stand-ins
  ledger/        multi-writer RAM ledger + stateRoot
  consensus/     anchor chain, fork choice, finality, difficulty, canonical order
  sync/          Nostr transport · chunked bulk frames · gossip · signed producer↔address bindings
  store/         durable write store (node:sqlite) + state snapshots/checkpoints + selective persist policy
  market/        app state anchors commit to (appRoot) — empty until the order board lands
  chains/        Esplora client for Bitcoin + Litecoin (UTXOs, txs, broadcast)
  daemon.ts      boots ledger + node + store + consensus
  server.ts      localhost JSON API for the desktop app
desktop/         native Rust client (GPUI Kit + GPUI Fast) — the Gavl app
```

---

## Trust model

**Trustless:** consensus, ordering, storage, and settlement — a swap either completes on both chains
or both sides refund, enforced by Bitcoin and Litecoin script, not by Gavl. No price oracle; the price
is whatever maker and taker agree to.

**Trusted per node:** the node's Esplora chain view (pick your own servers) and the user's own disk,
which holds swap secrets until each swap ends. Each channel is its own sandboxed network.

Testnet only until the swap engine is finished and audited.
