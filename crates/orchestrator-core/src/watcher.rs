//! Watcher — per-rule scheduler + poll loop + dedup. Pipeline (P1):
//!
//! ```text
//! for each enabled Rule every interval_min:
//!     items = connection.poll(since = rule.last_fetch, rule)
//!     for item in items:
//!         if scope.accepts(item) and item not in seen:
//!             emit Event(New); seen.insert(dedup_key)
//! ```
//!
//! The scheduler is connection-agnostic — it only talks to [`Connection`] and
//! the rule/condition engine.
//!
//! [`Connection`]: crate::connections::Connection

use crate::connections::{ConnectionKind, RawItem};
use crate::Timestamp;

/// `source|ts|headline` — identical scheme to companion tool's `seen` set.
pub fn dedup_key(source: ConnectionKind, ts: Timestamp, headline: &str) -> String {
    format!("{source:?}|{ts}|{headline}")
}

/// Turn a matched [`RawItem`] into a dedup key. Prefer the STABLE external id
/// (Slack ts / Jira key / GitLab `project!iid`) so an item that merely *updates*
/// (new commit, comment, title edit → new ts/headline) collapses onto one event
/// instead of spawning a duplicate. Falls back to `source|ts|headline` when there
/// is no external id.
pub fn item_dedup_key(item: &RawItem) -> String {
    if item.external_id.is_empty() {
        dedup_key(item.source, item.ts, &item.headline)
    } else {
        format!("{:?}|{}", item.source, item.external_id)
    }
}
