//! Blocking client for the local Gavl daemon's JSON API (`src/server.ts`).
//!
//! Every call runs on GPUI's background executor, never the UI thread.

use anyhow::{Context as _, Result, anyhow};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct Client {
    base: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base: impl Into<String>) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(10)))
            // Daemon errors come back as 4xx/5xx with `{ error }`; read the body instead of failing.
            .http_status_as_error(false)
            .build();
        Self { base: base.into(), agent: config.into() }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn state(&self) -> Result<Snapshot> {
        let v = self.get("/api/state")?;
        serde_json::from_value(v).context("decoding /api/state")
    }

    pub fn events(&self, since: u64) -> Result<EventPage> {
        let v = self.get(&format!("/api/events?since={since}"))?;
        serde_json::from_value(v).context("decoding /api/events")
    }

    pub fn set_active(&self, pub_hex: &str) -> Result<Value> {
        self.post("/api/accounts/active", json!({ "pubHex": pub_hex }))
    }

    pub fn set_gossip_interval(&self, seconds: u32) -> Result<Value> {
        self.post("/api/gossip-interval", json!({ "seconds": seconds }))
    }

    pub fn fleet_up(&self) -> Result<Value> {
        self.post_slow("/api/fleet/up", json!({}))
    }

    pub fn fleet_down(&self) -> Result<Value> {
        self.post("/api/fleet/down", json!({}))
    }

    // ── market / swaps / wallets (`None` = the daemon doesn't serve the endpoint yet) ──

    pub fn offers(&self) -> Result<Option<OffersPage>> {
        self.get_optional("/api/offers")?.map(|v| serde_json::from_value(v).context("decoding /api/offers")).transpose()
    }

    pub fn swaps(&self) -> Result<Option<Vec<Swap>>> {
        #[derive(Deserialize)]
        struct Page {
            #[serde(default)]
            swaps: Vec<Swap>,
        }
        let page: Option<Page> = self.get_optional("/api/swaps")?.map(serde_json::from_value).transpose().context("decoding /api/swaps")?;
        Ok(page.map(|p| p.swaps))
    }

    pub fn wallets(&self) -> Result<Option<Vec<Wallet>>> {
        #[derive(Deserialize)]
        struct Page {
            #[serde(default)]
            wallets: Vec<Wallet>,
        }
        let page: Option<Page> = self.get_optional("/api/wallets")?.map(serde_json::from_value).transpose().context("decoding /api/wallets")?;
        Ok(page.map(|p| p.wallets))
    }

    /// List an offer. Amounts are base units; `expires_in` is in anchors (~1 min each).
    pub fn post_offer(&self, give: Chain, give_amount: u64, want_amount: u64, min_fill: u64, expires_in: u32) -> Result<Value> {
        self.post_slow(
            "/api/offer",
            json!({
                "give": { "chain": give, "amount": give_amount.to_string() },
                "want": { "chain": give.other(), "amount": want_amount.to_string() },
                "minFill": min_fill.to_string(),
                "expiresIn": expires_in,
            }),
        )
    }

    pub fn take(&self, offer_id: &str, fill: u64) -> Result<Value> {
        self.post_slow("/api/take", json!({ "offerId": offer_id, "fill": fill.to_string() }))
    }

    pub fn cancel(&self, offer_id: &str) -> Result<Value> {
        self.post_slow("/api/cancel", json!({ "offerId": offer_id }))
    }

    pub fn send(&self, chain: Chain, to: &str, amount: u64, fee_rate: Option<f64>) -> Result<Value> {
        let mut body = json!({ "chain": chain, "to": to, "amount": amount.to_string() });
        if let Some(rate) = fee_rate {
            body["feeRate"] = json!(rate);
        }
        self.post_slow("/api/send", body)
    }

    fn get_optional(&self, path: &str) -> Result<Option<Value>> {
        let res = self.agent.get(format!("{}{path}", self.base)).call().with_context(|| format!("GET {path}"))?;
        if res.status() == ureq::http::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        read_json(res).map(Some)
    }

    fn get(&self, path: &str) -> Result<Value> {
        let res = self.agent.get(format!("{}{path}", self.base)).call().with_context(|| format!("GET {path}"))?;
        read_json(res)
    }

    fn post(&self, path: &str, body: Value) -> Result<Value> {
        let res = self.agent.post(format!("{}{path}", self.base)).send_json(&body).with_context(|| format!("POST {path}"))?;
        read_json(res)
    }

    /// Writes wait out a VDF cooldown (seconds to minutes on real PoST), so no global timeout.
    fn post_slow(&self, path: &str, body: Value) -> Result<Value> {
        let res = self
            .agent
            .post(format!("{}{path}", self.base))
            .config()
            .timeout_global(Some(Duration::from_secs(15 * 60)))
            .build()
            .send_json(&body)
            .with_context(|| format!("POST {path}"))?;
        read_json(res)
    }
}

fn read_json(mut res: ureq::http::Response<ureq::Body>) -> Result<Value> {
    let status = res.status();
    let v: Value = res.body_mut().read_json().unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(v);
    }
    let msg = v.get("error").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("HTTP {status}"));
    Err(anyhow!(msg))
}

// ── /api/state ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    pub accounts: Vec<AccountRef>,
    pub active: Option<String>,
    pub consensus: Option<Consensus>,
    pub fleet: Option<Fleet>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AccountRef {
    pub label: String,
    pub pub_hex: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Consensus {
    pub enabled: bool,
    pub vdf: String,
    pub space: String,
    pub network: String,
    pub peers: u32,
    pub farming: bool,
    pub tip: Option<Tip>,
    pub finalized_height: Option<u64>,
    pub producers: u32,
    pub i_produce: bool,
    pub my_anchors: u64,
    pub sec_per_anchor: f64,
    pub sec_per_anchor_measured: bool,
    pub transport: Option<String>,
    pub node_key: Option<String>,
    pub peer_keys: Vec<String>,
    pub pinned_peers: Vec<String>,
    pub max_peers: Option<u32>,
    pub bindings: u32,
    pub gossip_interval_sec: Option<u32>,
    pub relays_up: Option<u32>,
    pub relays_total: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Tip {
    pub height: u64,
    pub id: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Fleet {
    pub count: u32,
    pub cap: u32,
    pub nodes: Vec<FleetNode>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FleetNode {
    pub name: String,
    pub port: u16,
    pub up_sec: u64,
    pub state: Option<FleetNodeState>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FleetNodeState {
    pub address: Option<String>,
    pub tip: Option<u64>,
    pub peers: u32,
    pub producing: bool,
    pub farming: bool,
}

// ── /api/events ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct EventPage {
    pub events: Vec<NetEvent>,
    pub cursor: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct NetEvent {
    pub seq: u64,
    pub ts: u64,
    pub kind: String,
    pub text: String,
}

// ── chains + amounts ────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Chain {
    Bitcoin,
    Litecoin,
}

impl Chain {
    pub const ALL: [Chain; 2] = [Chain::Bitcoin, Chain::Litecoin];

    pub fn symbol(self) -> &'static str {
        match self {
            Chain::Bitcoin => "BTC",
            Chain::Litecoin => "LTC",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Chain::Bitcoin => "Bitcoin",
            Chain::Litecoin => "Litecoin",
        }
    }

    pub fn other(self) -> Chain {
        match self {
            Chain::Bitcoin => Chain::Litecoin,
            Chain::Litecoin => Chain::Bitcoin,
        }
    }

    /// Target block spacing, seconds.
    pub fn block_seconds(self) -> u64 {
        match self {
            Chain::Bitcoin => 600,
            Chain::Litecoin => 150,
        }
    }

    /// Smallest HTLC output the chain relays (P2TR dust; the fold's `DUST`).
    pub fn dust(self) -> u64 {
        match self {
            Chain::Bitcoin => 330,
            Chain::Litecoin => 3_300,
        }
    }
}

/// Base units sent as a decimal string (or, leniently, a JSON number).
fn units<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    match Value::deserialize(d)? {
        Value::String(s) => s.parse().map_err(serde::de::Error::custom),
        Value::Number(n) => n.as_u64().ok_or_else(|| serde::de::Error::custom("expected a non-negative integer")),
        Value::Null => Ok(0),
        other => Err(serde::de::Error::custom(format!("expected an amount, got {other}"))),
    }
}

/// Signed base units (mempool deltas can be negative).
fn signed_units<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<i64, D::Error> {
    match Value::deserialize(d)? {
        Value::String(s) => s.parse().map_err(serde::de::Error::custom),
        Value::Number(n) => n.as_i64().ok_or_else(|| serde::de::Error::custom("expected an integer")),
        Value::Null => Ok(0),
        other => Err(serde::de::Error::custom(format!("expected an amount, got {other}"))),
    }
}

// ── /api/offers ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct OffersPage {
    /// The tip anchor height the board is folded at (`null` before consensus).
    pub height: Option<u64>,
    pub offers: Vec<Offer>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Leg {
    pub chain: Chain,
    #[serde(deserialize_with = "units")]
    pub amount: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub id: String,
    pub maker: String,
    pub give: Leg,
    pub want: Leg,
    #[serde(deserialize_with = "units")]
    pub min_fill: u64,
    #[serde(deserialize_with = "units")]
    pub remaining: u64,
    #[serde(default)]
    pub expires_at: u64,
}

// ── /api/swaps ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Maker,
    Taker,
}

impl Role {
    /// Refund window of this party's lock: the taker (initiator) 24h, the maker 12h.
    pub fn refund_hours(self) -> u64 {
        match self {
            Role::Taker => 24,
            Role::Maker => 12,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Proofs,
    WaitingTakerLock,
    WaitingMakerLock,
    Claiming,
    WaitingCounterClaim,
    RefundPending,
    Refunded,
    Done,
    Cancelled,
    Failed,
    /// A stage this build doesn't know yet.
    #[serde(other)]
    Unknown,
}

impl Stage {
    /// Finished one way or another; nothing more will happen.
    pub fn is_final(self) -> bool {
        matches!(self, Stage::Refunded | Stage::Done | Stage::Cancelled | Stage::Failed)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Swap {
    pub match_id: String,
    /// The local identity (pubHex) that is the party; swaps cover every local identity.
    #[serde(default)]
    pub identity: Option<String>,
    pub role: Role,
    pub stage: Stage,
    pub my_chain: Chain,
    #[serde(deserialize_with = "units")]
    pub my_amount: u64,
    pub their_chain: Chain,
    #[serde(deserialize_with = "units")]
    pub their_amount: u64,
    #[serde(default)]
    pub my_lock: Option<Lock>,
    #[serde(default)]
    pub their_lock: Option<Lock>,
    #[serde(default)]
    pub claim_txid: Option<String>,
    #[serde(default)]
    pub refund_txid: Option<String>,
    #[serde(default)]
    pub refund_available_in_blocks: Option<i64>,
    #[serde(default)]
    pub deadline: Option<Deadline>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Lock {
    pub txid: String,
    pub vout: u32,
    pub confirmations: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Deadline {
    pub kind: String,
    pub anchors_left: i64,
}

// ── /api/wallets ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Deserialize)]
pub struct Wallet {
    pub chain: Chain,
    #[serde(default)]
    pub net: String,
    #[serde(default)]
    pub address: String,
    #[serde(default, deserialize_with = "units")]
    pub confirmed: u64,
    #[serde(default, deserialize_with = "signed_units")]
    pub unconfirmed: i64,
    /// Set when the chain's explorer was unreachable (balances then read `0`).
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_contract_shapes() {
        let offers: OffersPage = serde_json::from_value(json!({
            "height": 42,
            "offers": [{ "id": "o1", "maker": "ab", "give": { "chain": "bitcoin", "amount": "1000000" },
                "want": { "chain": "litecoin", "amount": "120000000" }, "minFill": "200000", "remaining": "600000",
                "postedAt": 40, "expiresAt": 1480 }],
        }))
        .unwrap();
        assert_eq!(offers.height, Some(42));
        assert_eq!((offers.offers[0].give.amount, offers.offers[0].want.chain), (1_000_000, Chain::Litecoin));

        let swap: Swap = serde_json::from_value(json!({
            "matchId": "m1", "offerId": "o1", "identity": "ab", "role": "taker", "stage": "waitingMakerLock",
            "myChain": "litecoin", "myAmount": "72000000", "theirChain": "bitcoin", "theirAmount": "600000",
            "myLock": { "txid": "ff", "vout": 0, "confirmations": 2 }, "deadline": { "kind": "takerLock", "anchorsLeft": 12 },
        }))
        .unwrap();
        assert_eq!((swap.role, swap.stage, swap.my_amount), (Role::Taker, Stage::WaitingMakerLock, 72_000_000));
        assert_eq!(swap.my_lock.map(|l| l.confirmations), Some(2));
        let future: Swap = serde_json::from_value(json!({
            "matchId": "m2", "role": "maker", "stage": "somethingNew", "myChain": "bitcoin", "myAmount": 1,
            "theirChain": "litecoin", "theirAmount": "2",
        }))
        .unwrap();
        assert_eq!(future.stage, Stage::Unknown);

        let wallet: Wallet = serde_json::from_value(json!({
            "chain": "bitcoin", "net": "regtest", "address": "bcrt1q", "confirmed": "5000", "unconfirmed": "-300",
        }))
        .unwrap();
        assert_eq!((wallet.confirmed, wallet.unconfirmed), (5_000, -300));
    }
}
