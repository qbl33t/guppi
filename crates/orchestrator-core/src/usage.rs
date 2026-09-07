//! Usage — accumulates token usage per session/case for display. No caps, no
//! budgets, no blocking. Fed by [`SessionEvent::Usage`].
//!
//! [`SessionEvent::Usage`]: crate::agents::SessionEvent::Usage

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Tokens {
    pub input: u64,
    pub output: u64,
}

impl Tokens {
    pub fn add(&mut self, input: u64, output: u64) {
        self.input += input;
        self.output += output;
    }
}

/// Running totals keyed by an id (session id or case id). Display only.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageTracker {
    pub by_key: HashMap<String, Tokens>,
}

impl UsageTracker {
    pub fn record(&mut self, key: &str, input: u64, output: u64) {
        self.by_key.entry(key.to_string()).or_default().add(input, output);
    }

    pub fn get(&self, key: &str) -> Tokens {
        self.by_key.get(key).copied().unwrap_or_default()
    }
}
