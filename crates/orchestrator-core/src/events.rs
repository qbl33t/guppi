//! Events — matched, deduped signals shown in the feed. Mirrors companion tool's
//! `watcher-items.json` plus rule/snooze bookkeeping.

use crate::connections::ConnectionKind;
use crate::Timestamp;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventStatus {
    New,
    Snoozed,
    Analyzing,
    CaseCreated,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub source: ConnectionKind,
    pub headline: String,
    pub body: String,
    pub ts: Timestamp,
    pub status: EventStatus,
    /// Source-native id (Slack message `ts`, GitLab iid, …) for detail fetch.
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    /// Human-readable channel/source name (e.g. `#incidents`) for display; the
    /// `channel` field keeps the raw id used for routing.
    #[serde(default)]
    pub channel_name: Option<String>,
    #[serde(default)]
    pub dm: bool,
    /// Rule that produced this event.
    pub rule_id: String,
    /// `source|ts|headline` — matches companion tool's `seen` scheme.
    pub dedup_key: String,
    #[serde(default)]
    pub snooze_until: Option<Timestamp>,
    #[serde(default)]
    pub case_uuid: Option<String>,
}
