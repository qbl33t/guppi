//! Slack connection — first concrete impl of the [`Connection`] seam.
//!
//! Read + poll + bot-token write live here (Rust HTTP). The *second* write
//! identity — posting as the logged-in Claude Code user via their MCP
//! connection — is not an HTTP call the core can make; it is routed by the
//! shell/agent layer (see `src-tauri`, and the agent runtime in P2). This
//! module owns everything the bot identity needs.

use super::{
    Connection, ConnectionAction, ConnectionKind, ContextBundle, ContextRef, ContextSection,
    RawItem, Update, Validity,
};
use crate::rules::Rule;
use crate::{CoreError, Result, Timestamp};
use std::collections::HashMap;
use std::sync::Mutex;

const API: &str = "https://slack.com/api";

pub struct SlackConnection {
    token: String,
    /// User token (`xoxp-…`) for DM read/write as the user; empty falls back to bot.
    user_token: Option<String>,
    channels: Vec<String>,
    /// Also poll the token owner's direct messages (Slack `im` conversations).
    dms: bool,
    client: reqwest::Client,
    /// user id → display name, resolved lazily.
    user_cache: Mutex<HashMap<String, String>>,
    /// channel id → name, resolved lazily.
    chan_cache: Mutex<HashMap<String, String>>,
}

impl SlackConnection {
    pub fn new(token: String, channels: Vec<String>) -> Self {
        Self {
            token,
            user_token: None,
            channels,
            dms: false,
            client: reqwest::Client::new(),
            user_cache: Mutex::new(HashMap::new()),
            chan_cache: Mutex::new(HashMap::new()),
        }
    }

    /// Enable/disable DM polling (chainable).
    pub fn with_dms(mut self, dms: bool) -> Self {
        self.dms = dms;
        self
    }

    /// Set the user token (`xoxp-…`) used for DM read/write (chainable).
    pub fn with_user_token(mut self, tok: String) -> Self {
        self.user_token = (!tok.is_empty()).then_some(tok);
        self
    }

    /// Whether a user token is configured (DMs available).
    pub fn has_user_token(&self) -> bool {
        self.user_token.is_some()
    }

    /// GET using the user token (falls back to the bot token if unset).
    async fn get_user(&self, method: &str, query: &[(&str, &str)]) -> Result<serde_json::Value> {
        let tok = self.user_token.as_deref().unwrap_or(&self.token);
        let resp = self
            .client
            .get(format!("{API}/{method}"))
            .bearer_auth(tok)
            .query(query)
            .send()
            .await
            .map_err(|e| Self::err(method, e))?;
        let v: serde_json::Value = resp.json().await.map_err(|e| Self::err(method, e))?;
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            return Err(Self::err(method, v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown")));
        }
        Ok(v)
    }

    /// The user's open DM conversations (Slack `im` channel ids) — via user token.
    async fn dm_channels(&self) -> Vec<String> {
        match self
            .get_user("users.conversations", &[("types", "im"), ("limit", "200")])
            .await
        {
            Ok(v) => v
                .get("channels")
                .and_then(|c| c.as_array())
                .map(|arr| arr.iter().filter_map(|c| c.get("id").and_then(|i| i.as_str()).map(String::from)).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    }

    /// Resolve a user id to a display name (cached). Falls back to the id.
    async fn user_name(&self, id: &str) -> String {
        if let Some(n) = self.user_cache.lock().unwrap().get(id).cloned() {
            return n;
        }
        let name = self
            .get("users.info", &[("user", id)])
            .await
            .ok()
            .and_then(|v| {
                let u = v.get("user")?;
                let p = u.get("profile");
                p.and_then(|p| p.get("display_name")).and_then(|s| s.as_str()).filter(|s| !s.is_empty())
                    .or_else(|| p.and_then(|p| p.get("real_name")).and_then(|s| s.as_str()))
                    .or_else(|| u.get("real_name").and_then(|s| s.as_str()))
                    .or_else(|| u.get("name").and_then(|s| s.as_str()))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| id.to_string());
        self.user_cache.lock().unwrap().insert(id.to_string(), name.clone());
        name
    }

    /// Resolve a channel id to a name (cached). Falls back to the id.
    async fn chan_name(&self, id: &str) -> String {
        if let Some(n) = self.chan_cache.lock().unwrap().get(id).cloned() {
            return n;
        }
        let name = self
            .get("conversations.info", &[("channel", id)])
            .await
            .ok()
            .and_then(|v| v.get("channel")?.get("name").and_then(|s| s.as_str()).map(str::to_string))
            .unwrap_or_else(|| id.to_string());
        self.chan_cache.lock().unwrap().insert(id.to_string(), name.clone());
        name
    }

    /// Replace Slack markup (`<@U…>`, `<#C…|name>`, `<url|text>`, …) with names.
    async fn humanize(&self, s: &str) -> String {
        let mut out = String::new();
        let mut rest = s;
        while let Some(lt) = rest.find('<') {
            out.push_str(&rest[..lt]);
            let after = &rest[lt + 1..];
            let Some(gt) = after.find('>') else {
                out.push_str(&rest[lt..]);
                return out;
            };
            let token = &after[..gt];
            out.push_str(&self.render_token(token).await);
            rest = &after[gt + 1..];
        }
        out.push_str(rest);
        out
    }

    async fn render_token(&self, token: &str) -> String {
        let (main, label) = match token.split_once('|') {
            Some((a, b)) => (a, Some(b)),
            None => (token, None),
        };
        if let Some(id) = main.strip_prefix('@') {
            format!("@{}", self.user_name(id).await)
        } else if let Some(id) = main.strip_prefix('#') {
            match label {
                Some(l) => format!("#{l}"),
                None => format!("#{}", self.chan_name(id).await),
            }
        } else if let Some(sub) = main.strip_prefix('!') {
            match label {
                Some(l) => format!("@{l}"),
                None => format!("@{sub}"),
            }
        } else {
            label.unwrap_or(main).to_string()
        }
    }

    fn err(ctx: &str, e: impl std::fmt::Display) -> CoreError {
        CoreError::Connection("Slack".into(), format!("{ctx}: {e}"))
    }

    async fn get(&self, method: &str, query: &[(&str, &str)]) -> Result<serde_json::Value> {
        let resp = self
            .client
            .get(format!("{API}/{method}"))
            .bearer_auth(&self.token)
            .query(query)
            .send()
            .await
            .map_err(|e| Self::err(method, e))?;
        let v: serde_json::Value = resp.json().await.map_err(|e| Self::err(method, e))?;
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            let e = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
            return Err(Self::err(method, e));
        }
        Ok(v)
    }

    /// List public + private channels (id, name) via the bot token — for the
    /// config UI's channel autocomplete + id→name resolution.
    pub async fn list_channels(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut cursor = String::new();
        for _ in 0..12 {
            let q: Vec<(&str, &str)> = vec![
                ("types", "public_channel,private_channel"),
                ("exclude_archived", "true"),
                ("limit", "200"),
                ("cursor", cursor.as_str()),
            ];
            let Ok(v) = self.get("conversations.list", &q).await else { break };
            if let Some(arr) = v.get("channels").and_then(|c| c.as_array()) {
                for c in arr {
                    if let (Some(id), Some(name)) = (
                        c.get("id").and_then(|x| x.as_str()),
                        c.get("name").and_then(|x| x.as_str()),
                    ) {
                        out.push((id.to_string(), name.to_string()));
                    }
                }
            }
            cursor = v
                .get("response_metadata")
                .and_then(|m| m.get("next_cursor"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            if cursor.is_empty() {
                break;
            }
        }
        out
    }

    /// Post a message as the bot. Returns the message `ts`.
    pub async fn post_message(&self, channel: &str, text: &str) -> Result<String> {
        self.chat_post(serde_json::json!({ "channel": channel, "text": text })).await
    }

    /// Reply in a thread. Returns the reply `ts`.
    pub async fn post_reply(&self, channel: &str, thread_ts: &str, text: &str) -> Result<String> {
        self.chat_post(serde_json::json!({
            "channel": channel, "thread_ts": thread_ts, "text": text
        }))
        .await
    }

    async fn chat_post(&self, body: serde_json::Value) -> Result<String> {
        let resp = self
            .client
            .post(format!("{API}/chat.postMessage"))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| Self::err("chat.postMessage", e))?;
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| Self::err("chat.postMessage", e))?;
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            let e = v.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
            return Err(Self::err("chat.postMessage", e));
        }
        Ok(v.get("ts").and_then(|t| t.as_str()).unwrap_or("").to_string())
    }

    fn message_to_item(channel: &str, m: &serde_json::Value) -> Option<RawItem> {
        let ts_str = m.get("ts")?.as_str()?;
        let ts = ts_str.split('.').next()?.parse::<Timestamp>().ok()?;
        let text = m.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
        let author = m.get("user").and_then(|u| u.as_str()).map(str::to_string);
        let emojis = m
            .get("reactions")
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Some(RawItem {
            source: ConnectionKind::Slack,
            external_id: ts_str.to_string(),
            ts,
            headline: format!("#{channel}"),
            body: text,
            author,
            emojis,
            scope: channel.to_string(),
            refs: vec![ContextRef::SlackThread {
                channel: channel.to_string(),
                ts: ts_str.to_string(),
            }],
            meta: Default::default(),
        })
    }
}

#[async_trait::async_trait]
impl Connection for SlackConnection {
    fn kind(&self) -> ConnectionKind {
        ConnectionKind::Slack
    }

    async fn validate(&self) -> Result<Validity> {
        match self.get("auth.test", &[]).await {
            Ok(v) => Ok(Validity {
                ok: true,
                detail: format!(
                    "{} @ {}",
                    v.get("user").and_then(|u| u.as_str()).unwrap_or("?"),
                    v.get("team").and_then(|t| t.as_str()).unwrap_or("?")
                ),
            }),
            Err(e) => Ok(Validity {
                ok: false,
                detail: e.to_string(),
            }),
        }
    }

    async fn poll(&self, since: Timestamp, _rule: &Rule) -> Result<Vec<RawItem>> {
        let oldest = since.to_string();
        let mut out = Vec::new();
        for ch in &self.channels {
            let v = self
                .get(
                    "conversations.history",
                    &[("channel", ch), ("oldest", &oldest), ("limit", "50")],
                )
                .await?;
            let cname = self.chan_name(ch).await;
            if let Some(msgs) = v.get("messages").and_then(|m| m.as_array()) {
                for m in msgs {
                    if let Some(mut item) = Self::message_to_item(ch, m) {
                        item.headline = format!("#{cname}");
                        item.meta.insert(
                            "channel_name".to_string(),
                            serde_json::Value::String(format!("#{cname}")),
                        );
                        if let Some(a) = item.author.take() {
                            item.author = Some(self.user_name(&a).await);
                        }
                        item.body = self.humanize(&item.body).await;
                        out.push(item);
                    }
                }
            }
        }
        // Also poll the user's DMs when enabled — same history call, DM-labelled.
        if self.dms {
            for ch in self.dm_channels().await {
                // Non-fatal: a missing DM scope shouldn't break channel polling.
                let Ok(v) = self
                    .get_user(
                        "conversations.history",
                        &[("channel", &ch), ("oldest", &oldest), ("limit", "50")],
                    )
                    .await
                else {
                    continue;
                };
                if let Some(msgs) = v.get("messages").and_then(|m| m.as_array()) {
                    for m in msgs {
                        if let Some(mut item) = Self::message_to_item(&ch, m) {
                            let name = match item.author.take() {
                                Some(a) => {
                                    let n = self.user_name(&a).await;
                                    item.author = Some(n.clone());
                                    n
                                }
                                None => "someone".to_string(),
                            };
                            item.headline = format!("DM · {name}");
                            item.meta.insert(
                                "channel_name".to_string(),
                                serde_json::Value::String(format!("DM · {name}")),
                            );
                            item.body = self.humanize(&item.body).await;
                            out.push(item);
                        }
                    }
                }
            }
        }
        out.sort_by_key(|i| i.ts);
        Ok(out)
    }

    async fn read_context(&self, refs: &[ContextRef]) -> Result<ContextBundle> {
        let mut sections = Vec::new();
        for r in refs {
            if let ContextRef::SlackThread { channel, ts } = r {
                let v = self
                    .get("conversations.replies", &[("channel", channel), ("ts", ts)])
                    .await?;
                let mut lines = Vec::new();
                for m in v.get("messages").and_then(|m| m.as_array()).into_iter().flatten() {
                    let author = match m.get("user").and_then(|u| u.as_str()) {
                        Some(u) => self.user_name(u).await,
                        None => "?".into(),
                    };
                    let body = self.humanize(m.get("text").and_then(|t| t.as_str()).unwrap_or("")).await;
                    lines.push(format!("{author}: {body}"));
                }
                sections.push(ContextSection {
                    title: format!("Slack thread #{} @ {ts}", self.chan_name(channel).await),
                    text: lines.join("\n"),
                });
            }
        }
        Ok(ContextBundle { sections })
    }

    async fn act(&self, action: &ConnectionAction) -> Result<String> {
        match action {
            ConnectionAction::SlackReply { channel, thread_ts, text } => {
                self.post_reply(channel, thread_ts, text).await
            }
            ConnectionAction::SlackPost { channel, text } => self.post_message(channel, text).await,
            other => Err(Self::err("act", format!("unsupported: {other:?}"))),
        }
    }

    /// `#name` for a channel, `DM · name` for a direct message; `#name`
    /// inputs pass through. Never surfaces a raw id when it can resolve one.
    async fn label(&self, dest: &str) -> String {
        if dest.starts_with('#') {
            return dest.to_string();
        }
        if dest.starts_with('D') {
            if let Ok(v) = self.get("conversations.info", &[("channel", dest)]).await {
                if let Some(u) = v.get("channel").and_then(|c| c.get("user")).and_then(|u| u.as_str()) {
                    return format!("DM · {}", self.user_name(u).await);
                }
            }
            return "DM".to_string();
        }
        if dest.starts_with('C') || dest.starts_with('G') {
            let n = self.chan_name(dest).await;
            return if n == dest { dest.to_string() } else { format!("#{n}") };
        }
        format!("#{}", dest.trim_start_matches('#'))
    }

    async fn permalink(&self, r: &ContextRef) -> Option<String> {
        let ContextRef::SlackThread { channel, ts } = r else { return None };
        self.get("chat.getPermalink", &[("channel", channel), ("message_ts", ts)])
            .await
            .ok()
            .and_then(|v| v.get("permalink").and_then(|p| p.as_str()).map(str::to_string))
    }

    async fn follow(&self, r: &ContextRef, since: Timestamp) -> Result<Vec<Update>> {
        let ContextRef::SlackThread { channel, ts } = r else { return Ok(vec![]) };
        let v = self
            .get("conversations.replies", &[("channel", channel), ("ts", ts)])
            .await?;
        let mut out = Vec::new();
        for m in v.get("messages").and_then(|m| m.as_array()).into_iter().flatten() {
            let mts = m.get("ts").and_then(|t| t.as_str()).unwrap_or("");
            let sec = mts.split('.').next().and_then(|s| s.parse::<Timestamp>().ok()).unwrap_or(0);
            if sec > since && mts != ts.as_str() {
                let author = match m.get("user").and_then(|u| u.as_str()) {
                    Some(u) => self.user_name(u).await,
                    None => "?".into(),
                };
                let text = self.humanize(m.get("text").and_then(|t| t.as_str()).unwrap_or("")).await;
                out.push(Update { ts: sec, author, text });
            }
        }
        Ok(out)
    }
}
