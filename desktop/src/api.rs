//! Blocking client for the local Gavl daemon's JSON API (`src/server.ts`).
//!
//! Every call runs on GPUI's background executor, never the UI thread. Amounts arrive as decimal
//! strings (BigInt-safe on the daemon side) and stay strings here; `amount()` parses on read.

use anyhow::{Context as _, Result, anyhow};
use serde::Deserialize;
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

    pub fn claim_deposit(&self, txid: &str) -> Result<Value> {
        self.post_slow("/api/deposit/claim", json!({ "txid": txid }))
    }

    pub fn withdraw(&self, amount: u128, btc_address: &str, fee: u128) -> Result<Value> {
        self.post_slow(
            "/api/withdraw",
            json!({ "amount": amount.to_string(), "btcAddress": btc_address, "fee": fee.to_string() }),
        )
    }

    pub fn process_withdrawals(&self) -> Result<Value> {
        self.post_slow("/api/withdrawals/process", json!({}))
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

/// Parse a decimal amount string; malformed or missing reads as 0 (display only — the daemon is authoritative).
pub fn amount(s: &str) -> u128 {
    s.trim().parse().unwrap_or(0)
}

// ── /api/state ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Snapshot {
    pub accounts: Vec<AccountRef>,
    pub active: Option<String>,
    pub bridge: Option<Bridge>,
    pub consensus: Option<Consensus>,
    pub custody: Option<Custody>,
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
pub struct Bridge {
    pub my_gbtc: String,
    pub idle_decay: Option<IdleDecay>,
    pub reserves: String,
    pub gbtc_outstanding: String,
    pub pending: String,
    pub pending_count: u32,
    pub deposit_address: Option<String>,
    pub fund_address: Option<String>,
    pub btc_network: String,
    pub on_chain_reserves: Option<String>,
    pub reconciled: Option<bool>,
    pub shortfall: Option<String>,
    pub pot: String,
    pub free: String,
    pub bonded: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IdleDecay {
    pub sweep_at_height: u64,
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
    pub committee_linked: u32,
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
pub struct Custody {
    pub mode: String,
    pub epoch: i64,
    pub fund_key_on_chain: Option<String>,
    pub fund_address: Option<String>,
    pub committee_id: Option<String>,
    pub holds_share: bool,
    pub committee: Vec<String>,
    pub threshold: u32,
    pub min_committee: u32,
    pub bonded: bool,
    pub my_bond: String,
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
