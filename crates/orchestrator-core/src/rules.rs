//! Watcher rules — mirror companion tool's `watcher.json` sources. A rule is a
//! per-connection polling spec; conditions are evaluated against [`RawItem`]s
//! by the (connection-agnostic) condition engine.

use crate::connections::{ConnectionKind, RawItem};
use crate::Timestamp;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub connection: ConnectionKind,
    pub enabled: bool,
    /// Poll cadence in minutes (cron expressions are a later addition).
    pub interval_min: u32,
    /// Free-form per-source toggles, e.g. Slack Channels/DMs, GitLab New MRs.
    #[serde(default)]
    pub opts: Vec<(String, bool)>,
    #[serde(default)]
    pub scopes: Vec<Scope>,
    #[serde(default)]
    pub blacklist: Vec<String>,
    #[serde(default)]
    pub last_fetch: Timestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scope {
    /// channel / repo / project / space.
    pub target: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
    #[serde(default)]
    pub ignore: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Condition {
    pub kind: ConditionKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConditionKind {
    Emoji,
    Contains,
    Regex,
    Author,
    Any,
    /// Match a source-specific status carried in `RawItem.meta["status"]`
    /// (e.g. Jira issue status). Case-insensitive equality.
    Status,
}

impl Condition {
    /// Evaluate a single condition against a normalized item.
    /// P0: substring/equality matching; `Regex` compiles in P1 (needs `regex`).
    pub fn matches(&self, item: &RawItem) -> bool {
        match self.kind {
            ConditionKind::Any => true,
            // Slack reactions are stored by NAME (e.g. `eyes`). Match leniently:
            // strip surrounding `:` and compare case-insensitively.
            ConditionKind::Emoji => {
                let want = self.value.trim().trim_matches(':').to_lowercase();
                item.emojis.iter().any(|e| e.trim().trim_matches(':').to_lowercase() == want)
            }
            ConditionKind::Author => item.author.as_deref() == Some(self.value.as_str()),
            ConditionKind::Contains => {
                item.headline.contains(&self.value) || item.body.contains(&self.value)
            }
            ConditionKind::Regex => regex::Regex::new(&self.value)
                .map(|re| re.is_match(&item.headline) || re.is_match(&item.body))
                .unwrap_or(false),
            ConditionKind::Status => item
                .meta
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.eq_ignore_ascii_case(self.value.trim()))
                .unwrap_or(false),
        }
    }
}

impl Scope {
    /// All conditions must match (AND); `ignore` short-circuits to false.
    pub fn accepts(&self, item: &RawItem) -> bool {
        if !self.ignore.is_empty()
            && (item.headline.contains(&self.ignore) || item.body.contains(&self.ignore))
        {
            return false;
        }
        self.conditions.iter().all(|c| c.matches(item))
    }
}
