# Gavl

A decentralized **peer-to-peer Bitcoin bull/bear market** on a **Proof-of-Space-Time
cooldown ledger**, built on [Holepunch](https://github.com/holepunchto) (hypercore /
hyperswarm / hyperdht).

Broadcast an intent to go **long** or **short** on Bitcoin; a real peer takes the opposite
side; the two of you escrow against *each other* and settle at a signed oracle price.
**There is no pool and no house** — every trade is a matched, zero-sum, fully-collateralized
bet between two people, so the protocol is never a counterparty and reserves can never be
drained. No counterparty → no trade. No servers and no global chain to replay from genesis —
state is computed in RAM, verified against your current peers, and persisted to a local
append-only log. Every write pays a **cooldown** (a proof of space *and* a proof of time),
so an attacker can't spin up cheap identities to flood or grind the network.

The price comes from a **signed, on-chain oracle**. Collateral is **gBTC** — a 1:1 claim on
real Bitcoin held in a **threshold-custody fund** that only a quorum can spend (no single
party ever holds the key).

> **Status:** the matched market (consensus + intents + oracle) is complete and runs live,
> including cross-node intent gossip. The real-BTC bridge runs end-to-end on **testnet**.
> Mainnet is gated on an audit and four named items — see
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
3. **A match** escrows both peers' gBTC and opens a bilateral contract, marked to the oracle.
4. **Close** any time at the current mark — directional PnL, capped at the stake.
5. **Withdraw** — burn gBTC → a quorum threshold-signs and broadcasts a real Bitcoin tx.

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
  `2·stake` pot by directional PnL at the oracle mark, capped at the stake. The loser can
  never owe more than it posted, and **the protocol is never the counterparty — so reserves
  can't be drained.** "Leverage" just scales the price move and tightens the cap (at *L*×, a
  `1/L` move against you wipes your stake).
- **No counterparty → no trade.** With nobody on the other side, an intent simply rests
  until a peer takes it. That's the honest shape of a decentralized market — the easy
  long/short button takes resting liquidity if any exists, otherwise broadcasts your own.
- **Partial fills + cross-node.** One offer fills across many takers (tracked by nonce);
  intents propagate epidemically, so a peer on another machine sees your tape and can take it.
- **Conservation, proven.** `reserves == free gBTC + bonded + contract escrow + pending`.
  Match/settle only *move* gBTC between buckets, never mint — tested as a hard invariant over
  4,000-step random op streams. (`src/market/intent.ts`)

### The oracle (`src/market/oracle.ts`, `src/market/pricefeed.ts`)

The price is the one *trusted* part — and it's made transparent:

- Prices enter as **signed `oracle.post` writes folded by every node** (monotonic seq),
  not per-node web fetches (which would diverge).
- The publisher averages **three independent feeds** (Coinbase, Kraken, Bitstamp), so one
  bad/offline source can't set the mark.
- The oracle **discloses its methodology on-chain** (`oracle.meta`) — every client sees the
  exact endpoints + keys it derives the price from, and can audit the posted price against
  them.
- **The honest caveat:** verifying the signature proves *who* posted, not that the price is
  *true*. v1 is a single signer (the one trusted party). Multiple independent signers with
  an on-chain median is the trust-removing upgrade.

---

## The real-BTC bridge (`src/custody`)

gBTC is a 1:1 claim on Bitcoin in a fund **no single party can spend** — secured by FROST
threshold Schnorr (Taproot-compatible), proven against Bitcoin's own BIP340 verifier.

- **Threshold signing** (`threshold.ts`) — a quorum (min-of-max) produces one valid
  signature for the fund's single key, without anyone reconstructing it.
- **DKG** (`threshold.ts`) — distributed key generation: the key is born as shares; no one
  ever sees it whole, even at setup.
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

The Phase-0 spikes — Shamir secret sharing, proactive resharing under churn, and
VDF-seeded stake-weighted committee sampling (`custody/{shamir,reshare,sampling}.ts`) — are
the foundation for rotating the committee that holds the shares.

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

---

## Layout

```
src/
  chain/         per-writer PoST write + quality→iters coupling
  pot/  pos/     proof of time (chiavdf) · proof of space (chiapos) + stand-ins
  ledger/        multi-writer RAM ledger + stateRoot
  consensus/     anchor chain, fork choice, finality, difficulty, canonical order
  sync/          hyperswarm/hyperdht mesh, gossip, peer/bootstrap management
  store/         durable hypercore write store + selective persist policy
  market/        the matched market: intents + bilateral contracts (intent.ts), btc fold, ops, account, oracle, pricefeed
  custody/       real-BTC bridge: threshold (FROST) · DKG · Taproot · per-identity deposits · tx · ledger · watcher · esplora
  daemon.ts      boots ledger + node + store + consensus + oracle publisher + bridge + intent book
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

`npm run dev` is the zero-setup path: it boots the daemon (fast VDF, oracle publishing,
local-only) **and** the web UI in one command, cross-platform — no env vars to type.

> **Windows / browser note:** the UI binds IPv6, so open **`http://localhost:5180`**, not
> `http://127.0.0.1:5180`.

Other scripts:

```bash
npm test                 # full suite (~150 tests): consensus, matched market, intent gossip, oracle, custody, bridge
npm run demo             # PoST cooldown chain — watch space→cooldown
npm run demo:consensus   # two nodes farm + gossip anchors, finalize the same state over a real mesh
npm run daemon           # daemon only (real chiavdf VDF — needs the .venv; see below)
npm run web:dev          # web UI only (expects a daemon on :6440)
```

Tuning env vars (set inline on macOS/Linux; on Windows use `set VAR=…` or `$env:VAR=…`, or
just edit the `daemon:dev` script): `GAVL_VDF=hash|chia` · `GAVL_ORACLE_PUBLISH=1` (this node
holds the oracle key) · `GAVL_BTC_NET=testnet|signet|mainnet` · `GAVL_PERSIST=all|mine|off` ·
`GAVL_MESH=0` (disable the mesh — runs local-only; on by default) · `GAVL_NETWORK=<channel>`.
The real chiavdf VDF (`GAVL_VDF=chia`, the daemon's default) needs a Python venv with
`chiavdf`/`chiapos`; `npm run dev` sidesteps this by using `GAVL_VDF=hash`.

**Trade against yourself or a peer.** The market needs two sides, so either flip between two
identities (the account picker, bottom-left) or run a second node on the same channel:
broadcast an intent on one, **take** the opposite side on the other → a matched contract
opens, both sides escrow, and it settles at the oracle mark when either side closes.

**Testnet round-trip:** open the UI → **Wallet & custody** → send testnet BTC to *your*
deposit address → paste the txid to claim → mint gBTC → broadcast/take an intent → close →
withdraw → process payouts (broadcasts a real testnet BTC tx).

---

## Trust model & status

What's **trustless**: consensus, ordering, storage (no node is trusted); the matched market
(zero-sum, fully-collateralized, conservation proven — no pool to go insolvent); the
threshold signing (no one holds the fund key).

What's **trusted** (and surfaced honestly in the UI):

- **The oracle price** — a single signer in v1 (mitigable with a multi-signer median).
- **The bridge, on testnet** — currently **single-operator**: the daemon holds all the
  fund's key shares (deterministic dev seed) and is the deposit attestor. Real BTC custody
  is never zero-trust; this pushes trust as thin as it goes, but it isn't there yet.

**Before any mainnet satoshi, four gates must close:**

1. **Independent audit.**
2. **Real distributed DKG** across independent nodes (not in-process).
3. **Bonding + slashing** so the honest-majority assumption is economically enforced.
4. **Non-public keys** — the oracle / attestor / fund keys currently derive from public dev
   seeds (fine for testnet, instant theft on mainnet).

## Roadmap

- **Consensus** ✅ PoST cooldown · RAM ledger + gossip · anchor chain, finality, canonical
  order, difficulty retarget, sticky finality · durable selective storage · live over a
  real hyperdht mesh
- **Peer-to-peer matched market** ✅ signed intents gossiped over the mesh · matched
  bilateral contracts · zero-sum, fully-collateralized, **no pool** (reserves can't be
  drained) · bounded leverage · oracle-marked · close-anytime · cross-node intent tape ·
  Svelte tape/trade UI
- **Oracle** ✅ signed on-chain · 3-feed average · on-chain methodology disclosure · live
  feeds. **Next:** multiple independent signers + median.
- **Real-BTC bridge (testnet)** ✅ FROST threshold signing · DKG · Taproot address +
  BIP340-valid spends · withdrawal tx build/sign/broadcast · deposit watcher · bridge
  ledger · proof of reserves
- **Mainnet** ⛔ gated on the four items above (audit, distributed DKG, bonding/slashing,
  non-public keys)
