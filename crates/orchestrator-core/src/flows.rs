//! Flows — reusable task recipes as markdown playbooks (`flows/*.md`). A flow is
//! *data*, not code: the flows editor is CRUD over these files, so adding one
//! never touches the engine. Loaded into a step's init prompt at spawn time.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flow {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The playbook body (markdown). Prompted verbatim.
    pub body: String,
}

impl Flow {
    /// Parse a `flows/<name>.md` file. First `# heading` (if present) is the
    /// description; the whole body is used for prompting.
    pub fn from_markdown(name: impl Into<String>, md: &str) -> Self {
        let description = md
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l.trim_start_matches("# ").trim().to_string())
            .unwrap_or_default();
        Flow {
            name: name.into(),
            description,
            body: md.to_string(),
        }
    }
}
