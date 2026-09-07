//! Jira connection — second concrete `Connection` impl. Read (issues via JQL),
//! `read_context` (issue + comments), and write-back (`act`: comment / update
//! description / transition). Jira Cloud REST v3; ADF for rich text.

use super::{
    Connection, ConnectionAction, ConnectionKind, ContextBundle, ContextRef, ContextSection,
    RawItem, Update, Validity,
};
use crate::rules::Rule;
use crate::{CoreError, Result, Timestamp};

pub struct JiraConnection {
    base: String,
    email: String,
    token: String,
    projects: Vec<String>,
    window_min: u32,
    client: reqwest::Client,
}

impl JiraConnection {
    pub fn new(base: String, email: String, token: String, projects: Vec<String>, window_min: u32) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            email,
            token,
            projects,
            window_min: window_min.max(1),
            client: reqwest::Client::new(),
        }
    }

    fn err(ctx: &str, e: impl std::fmt::Display) -> CoreError {
        CoreError::Connection("Jira".into(), format!("{ctx}: {e}"))
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{}", self.base, path))
            .basic_auth(&self.email, Some(&self.token))
    }

    async fn get_json(&self, path: &str, query: &[(&str, &str)]) -> Result<serde_json::Value> {
        let resp = self
            .req(reqwest::Method::GET, path)
            .query(query)
            .send()
            .await
            .map_err(|e| Self::err(path, e))?;
        resp.json().await.map_err(|e| Self::err(path, e))
    }

    fn parse_ts(s: &str) -> Timestamp {
        chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.3f%z")
            .map(|dt| dt.timestamp())
            .unwrap_or(0)
    }

    /// Flatten an ADF node tree into plain text.
    fn adf_to_text(v: &serde_json::Value, out: &mut String) {
        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
            out.push_str(t);
        }
        if let Some(arr) = v.get("content").and_then(|c| c.as_array()) {
            for c in arr {
                Self::adf_to_text(c, out);
            }
            if matches!(
                v.get("type").and_then(|t| t.as_str()),
                Some("paragraph") | Some("heading") | Some("listItem")
            ) {
                out.push('\n');
            }
        }
    }

    /// Build a minimal ADF document from plain text (for comments/descriptions).
    fn adf_doc(text: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "doc",
            "version": 1,
            "content": [{
                "type": "paragraph",
                "content": [{ "type": "text", "text": text }]
            }]
        })
    }

    fn jql(&self) -> String {
        let mut parts = Vec::new();
        if !self.projects.is_empty() {
            parts.push(format!("project in ({})", self.projects.join(",")));
        }
        parts.push(format!("updated >= -{}m", self.window_min));
        format!("{} ORDER BY updated DESC", parts.join(" AND "))
    }
}

#[async_trait::async_trait]
impl Connection for JiraConnection {
    fn kind(&self) -> ConnectionKind {
        ConnectionKind::Jira
    }

    async fn validate(&self) -> Result<Validity> {
        match self.get_json("/rest/api/3/myself", &[]).await {
            Ok(v) => Ok(Validity {
                ok: v.get("accountId").is_some(),
                detail: v
                    .get("displayName")
                    .and_then(|n| n.as_str())
                    .unwrap_or("?")
                    .to_string(),
            }),
            Err(e) => Ok(Validity { ok: false, detail: e.to_string() }),
        }
    }

    async fn poll(&self, _since: Timestamp, _rule: &Rule) -> Result<Vec<RawItem>> {
        let jql = self.jql();
        let v = self
            .get_json(
                "/rest/api/3/search/jql",
                &[
                    ("jql", &jql),
                    ("maxResults", "50"),
                    ("fields", "summary,updated,reporter,status"),
                ],
            )
            .await?;
        let mut out = Vec::new();
        for issue in v.get("issues").and_then(|i| i.as_array()).into_iter().flatten() {
            let key = issue.get("key").and_then(|k| k.as_str()).unwrap_or_default().to_string();
            let f = issue.get("fields").cloned().unwrap_or_default();
            let summary = f.get("summary").and_then(|s| s.as_str()).unwrap_or_default().to_string();
            let status = f
                .get("status")
                .and_then(|s| s.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or_default();
            let ts = f.get("updated").and_then(|u| u.as_str()).map(Self::parse_ts).unwrap_or(0);
            let author = f
                .get("reporter")
                .and_then(|r| r.get("displayName"))
                .and_then(|n| n.as_str())
                .map(str::to_string);
            let project = key.split('-').next().unwrap_or_default().to_string();
            let mut meta = std::collections::HashMap::new();
            meta.insert("status".to_string(), serde_json::Value::String(status.to_string()));
            out.push(RawItem {
                source: ConnectionKind::Jira,
                external_id: key.clone(),
                ts,
                headline: format!("{key} · {status}"),
                body: summary,
                author,
                emojis: vec![],
                scope: project,
                refs: vec![ContextRef::JiraIssue(key)],
                meta,
            });
        }
        out.sort_by_key(|i| i.ts);
        Ok(out)
    }

    async fn read_context(&self, refs: &[ContextRef]) -> Result<ContextBundle> {
        let mut sections = Vec::new();
        for r in refs {
            if let ContextRef::JiraIssue(key) = r {
                let issue = self
                    .get_json(
                        &format!("/rest/api/3/issue/{key}"),
                        &[("fields", "summary,description,status,reporter")],
                    )
                    .await?;
                let f = issue.get("fields").cloned().unwrap_or_default();
                let mut text = String::new();
                if let Some(s) = f.get("summary").and_then(|s| s.as_str()) {
                    text.push_str(&format!("Summary: {s}\n"));
                }
                if let Some(desc) = f.get("description") {
                    let mut d = String::new();
                    Self::adf_to_text(desc, &mut d);
                    if !d.trim().is_empty() {
                        text.push_str(&format!("Description:\n{}\n", d.trim()));
                    }
                }
                let comments = self
                    .get_json(&format!("/rest/api/3/issue/{key}/comment"), &[("maxResults", "20")])
                    .await
                    .ok();
                if let Some(cs) = comments.as_ref().and_then(|c| c.get("comments")).and_then(|c| c.as_array()) {
                    for c in cs {
                        let author = c
                            .get("author")
                            .and_then(|a| a.get("displayName"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("?");
                        let mut body = String::new();
                        if let Some(b) = c.get("body") {
                            Self::adf_to_text(b, &mut body);
                        }
                        text.push_str(&format!("\n[comment · {author}] {}", body.trim()));
                    }
                }
                sections.push(ContextSection { title: format!("Jira {key}"), text });
            }
        }
        Ok(ContextBundle { sections })
    }

    async fn act(&self, action: &ConnectionAction) -> Result<String> {
        match action {
            ConnectionAction::JiraComment { issue, body } => {
                let resp = self
                    .req(reqwest::Method::POST, &format!("/rest/api/3/issue/{issue}/comment"))
                    .json(&serde_json::json!({ "body": Self::adf_doc(body) }))
                    .send()
                    .await
                    .map_err(|e| Self::err("comment", e))?;
                let v: serde_json::Value = resp.json().await.map_err(|e| Self::err("comment", e))?;
                Ok(v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string())
            }
            ConnectionAction::JiraUpdateDescription { issue, body } => {
                self.req(reqwest::Method::PUT, &format!("/rest/api/3/issue/{issue}"))
                    .json(&serde_json::json!({ "fields": { "description": Self::adf_doc(body) } }))
                    .send()
                    .await
                    .map_err(|e| Self::err("update", e))?;
                Ok("updated".into())
            }
            ConnectionAction::JiraTransition { issue, to } => {
                let ts = self
                    .get_json(&format!("/rest/api/3/issue/{issue}/transitions"), &[])
                    .await?;
                let id = ts
                    .get("transitions")
                    .and_then(|t| t.as_array())
                    .and_then(|arr| {
                        arr.iter().find(|t| {
                            t.get("name").and_then(|n| n.as_str()).map(|n| n.eq_ignore_ascii_case(to))
                                == Some(true)
                        })
                    })
                    .and_then(|t| t.get("id").and_then(|i| i.as_str()))
                    .ok_or_else(|| Self::err("transition", format!("no transition '{to}'")))?
                    .to_string();
                self.req(reqwest::Method::POST, &format!("/rest/api/3/issue/{issue}/transitions"))
                    .json(&serde_json::json!({ "transition": { "id": id } }))
                    .send()
                    .await
                    .map_err(|e| Self::err("transition", e))?;
                Ok(format!("transitioned to {to}"))
            }
            other => Err(Self::err("act", format!("unsupported: {other:?}"))),
        }
    }

    async fn follow(&self, r: &ContextRef, since: Timestamp) -> Result<Vec<Update>> {
        let ContextRef::JiraIssue(key) = r else { return Ok(vec![]) };
        let v = self
            .get_json(&format!("/rest/api/3/issue/{key}/comment"), &[("maxResults", "50")])
            .await?;
        let mut out = Vec::new();
        for c in v.get("comments").and_then(|c| c.as_array()).into_iter().flatten() {
            let created = c.get("created").and_then(|s| s.as_str()).map(Self::parse_ts).unwrap_or(0);
            if created > since {
                let author = c
                    .get("author")
                    .and_then(|a| a.get("displayName"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("?")
                    .to_string();
                let mut body = String::new();
                if let Some(b) = c.get("body") {
                    Self::adf_to_text(b, &mut body);
                }
                out.push(Update { ts: created, author, text: body.trim().to_string() });
            }
        }
        Ok(out)
    }
}
