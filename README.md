# Gavl

A decentralized **Bitcoin bull/bear perpetual exchange** on a **Proof-of-Space-Time
cooldown ledger**, built on [Holepunch](https://github.com/holepunchto) (hypercore /
hyperswarm / hyperdht).

Put collateral in, go **bullish** or **bearish** on Bitcoin with bounded leverage, take
it out worth more or less depending on how BTC moved. That's the whole product. There are
no servers and no global chain to replay from genesis — state is computed in RAM, verified
against your current peers, and persisted to a local append-only log. Every write pays a
**cooldown** (a proof of space *and* a proof of time), so an attacker can't spin up cheap
identities to flood or grind the network.

The price comes from a **signed, on-chain oracle** (no internal order book). Collateral is
**gBTC** — a 1:1 claim on real Bitcoin held in a **threshold-custody fund** that only a
quorum can spend (no single party ever holds the key).

> **Status:** the native exchange (consensus + perp + oracle) is complete and runs live.
> The real-BTC bridge runs end-to-end on **testnet**. Mainnet is gated on an audit and
> four named items — see [Trust model & status](#trust-model--status). Don't put real
> mainnet BTC in it yet.

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

## The product — BTC bull/bear

1. **Deposit** real (testnet) BTC to the fund's Taproot address → mint **gBTC** 1:1.
2. **Take a position** — Bullish (long) or Bearish (short) on Bitcoin, bounded leverage
   (≤ 5×), collateralized in gBTC.
3. **Withdraw** — burn gBTC → a quorum threshold-signs and broadcasts a real Bitcoin
   transaction sending BTC back to you.

### The perpetual engine (`src/perp`, `src/market/btc.ts`)

Oracle-priced and **pool-as-counterparty** — there is no order book. You trade against a
shared pool; the mark is the signed oracle price.

- **Mark = the oracle**, not an internal book. (`src/market/btc.ts`)
- **Pool-as-counterparty.** Open/close against a shared gBTC pool; no matching needed.
- **Insolvency-possible, but honest.** A win is paid from the pool (funded by losers + LPs).
  If the crowd is collectively right and the pool can't cover a win, the unpaid remainder
  is **queued pay-when-able** — the pool never goes negative, no gBTC is ever minted, and
  the shortfall is visible (a backing ratio + a per-account "owed" amount), never hidden.
  (`src/perp/pool.ts`)
- **Funding as solvency defense.** No spot to peg to, so funding's job is to price the
  pool's directional risk: the crowded side pays the other, scaled by open-interest skew —
  pushing the book back toward balance. (`src/perp/funding.ts`)
- **Bounded leverage + liquidation.** Leverage is capped because the clock is slow
  (liquidation finalizes minutes deep). A position's liquidation price is shown up front;
  a fully-collateralized 1× long has none (loss is capped at margin). (`src/perp/engine.ts`)
- **Conservation, proven.** Collateral is never created or destroyed; PnL is zero-sum
  between the sides. Tested as a hard invariant.

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
  timestamps, neutralizing the `ts`-reorder attack while respecting funding causality.
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
  market/        the product: btc fold (gBTC + perp + oracle), ops, account, oracle, pricefeed
  perp/          perp math: engine (PnL/liq), pool (pay-when-able), funding
  custody/       real-BTC bridge: threshold (FROST) · DKG · Taproot · tx · ledger · watcher · esplora
  daemon.ts      boots ledger + node + store + consensus + oracle publisher + bridge
  server.ts      localhost JSON API for the web UI
web/             Svelte SPA — the BTC bull/bear trading UI
```

---

## Run

Needs Node ≥ 23.6 (native TypeScript — no build step).

```bash
npm test                 # full suite (90 tests): consensus, perp, oracle, custody, bridge, watcher
npm run demo             # PoST cooldown chain — watch space→cooldown
npm run demo:consensus   # two nodes farm + gossip anchors, finalize the same state over a real mesh

# the live app:
GAVL_ORACLE_PUBLISH=1 npm run daemon   # daemon: consensus + farming + 3-feed oracle publisher + bridge
npm run web:dev                        # web UI → http://localhost:5180
```

Useful env: `GAVL_VDF=hash` (fast stand-in VDF) · `GAVL_BTC_NET=testnet|signet|mainnet` ·
`GAVL_ORACLE_PUBLISH=1` (this node holds the oracle key) · `GAVL_PERSIST=all|mine|off` ·
`GAVL_MESH=0` (local only) · `GAVL_NETWORK=<channel>`.

**Testnet round-trip:** open the UI → send testnet BTC to the fund address shown in the
Custody panel → paste the txid to claim → mint gBTC → trade → withdraw → process payouts
(broadcasts a real testnet BTC tx).

---

## Trust model & status

What's **trustless**: consensus, ordering, storage (no node is trusted); the perp math
(conservation proven); the threshold signing (no one holds the fund key).

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
- **Native BTC bull/bear exchange** ✅ oracle-priced pool perp · bounded leverage ·
  funding-as-solvency-defense · pay-when-able insolvency (visible) · liquidation · gBTC
  collateral · Svelte trading UI
- **Oracle** ✅ signed on-chain · 3-feed average · on-chain methodology disclosure · live
  feeds. **Next:** multiple independent signers + median.
- **Real-BTC bridge (testnet)** ✅ FROST threshold signing · DKG · Taproot address +
  BIP340-valid spends · withdrawal tx build/sign/broadcast · deposit watcher · bridge
  ledger · proof of reserves
- **Mainnet** ⛔ gated on the four items above (audit, distributed DKG, bonding/slashing,
  non-public keys)
