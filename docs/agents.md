# Driving Gavl Rounds with an agent

Gavl's flagship action is deliberately tiny: **enter the current round UP or DOWN with a stake**.
That makes it the safest possible action space to hand to a script or an AI — capped loss per action
(your stake, ever: no liquidations, no margin calls), one decision per ~15-minute round, and no
latency race (PoST cooldown + 60s anchors + the pre-lock entry cutoff mean a colocated bot has no
edge over a phone — strategy wins, speed doesn't).

An agent is **just another caller of your own node's local API**. It signs with your node's active
account, pays the same PoST cooldown per write, and holds no special powers — all nodes equal.

## The API (your node, default `http://127.0.0.1:6440`)

### `GET /api/rounds`
The rounds clock + pools. Synthesized from the anchor height even when nobody has entered yet.

```json
{
  "len": 15, "vigBps": 300, "minStake": "1000", "tip": 47,
  "entryOpen": true,
  "entering": { "idx": 3, "locksAt": 60, "closesAt": 75, "strike": null,
                "poolUp": "182000", "poolDown": "94000", "entries": 14,
                "mySide": "up", "myStake": "25000" },
  "live":     { "idx": 2, "strike": "6074367000000", "closesAt": 60, "...": "..." },
  "history":  [ { "idx": 1, "outcome": "up", "mySide": "up", "myStake": "10000", "myPayout": "15230", "...": "..." } ]
}
```

- Round `idx` accepts entries while `tip < locksAt − 1` (the last anchor before lock is a cutoff).
- **strike** is snapshotted by the first confidence-OK oracle write at/after `locksAt`; the round
  settles the same way at `closesAt`. Winners split the losing pool pro-rata; `vigBps` of the losing
  pool feeds the liquidity pot. Tie / one-sided / oracle-dark rounds refund.
- Prices are integers at the feed's scale (`/api/state` → `market.priceExpo`, e.g. −8).

### `POST /api/round/enter` — the one verb
```bash
curl -s -X POST localhost:6440/api/round/enter \
  -H 'content-type: application/json' \
  -d '{"side": "up", "stake": "5000"}'
```
`idx` is optional (defaults to the currently-accepting round — pass it to pin one). Re-entering the
same side **tops you up**; the other side is rejected while you hold a slot. When a round is full
(10,000 entries), admission is top-N-by-stake: strictly out-stake the floor entry or you're refused.

### `GET /api/state`
Everything above under `market.rounds`, plus your balance (`market.myGbtc`), the mark
(`market.price`), and the consensus tip — one poll drives a whole bot.

### `GET | POST /api/autopilot`
The built-in rules engine (momentum / follow / contrarian, per-day budget, loss-streak auto-stop) —
see the AUTOPILOT fold in the UI, or configure it directly:
```bash
curl -s -X POST localhost:6440/api/autopilot \
  -H 'content-type: application/json' \
  -d '{"enabled": true, "strategy": "momentum", "momentumBps": 10, "stake": "1000"}'
```
POST accepts any subset of the config and returns the live status. Config persists at
`<data>/autopilot.json`. Writing your own agent? Disable the autopilot so they don't both enter.

## An external bot in ~40 lines

[`scripts/round-bot.mjs`](../scripts/round-bot.mjs) — a self-contained momentum bot over the HTTP
API (no imports from the codebase). Run it against your node:

```bash
node scripts/round-bot.mjs                        # defaults: localhost:6440, 10 bps, 1000 gBTC
GAVL_API=http://127.0.0.1:6450 STAKE=5000 node scripts/round-bot.mjs
```

Swap `decide()` for anything — an indicator stack, a rules DSL, an LLM call. The protocol doesn't
care who's pressing the button; it only ever sees `round.enter`.
