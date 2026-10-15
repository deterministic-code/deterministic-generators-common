use std::collections::HashMap;

use crate::error::Error;

pub const FRONTEND_FRAMEWORKS: [&str; 4] = ["vite", "next", "svelte", "angular"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub application_name: String,
    pub frontend_framework: String,
    pub full_stack: bool,
    pub schema_version: String,
    pub simple_doc: bool,
    pub description_doc: bool,
    pub create_index: bool,
    pub library_reference_mode: Option<String>,
}

pub fn from_settings(raw: &HashMap<String, String>) -> Result<Settings, Error> {
    let comments = raw.get("comments").map(String::as_str);
    let frontend_framework = raw.get("frontend_generate_framework").map(String::as_str);
    if let Some(value) = frontend_framework {
        if !value.is_empty() && !FRONTEND_FRAMEWORKS.contains(&value) {
            let allowed = FRONTEND_FRAMEWORKS
                .iter()
                .map(|name| format!("\"{name}\""))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(Error::new(format!(
                "settings.frontend_generate_framework must be {allowed}, got \"{value}\""
            )));
        }
    }
    let application_name = raw
        .get("application_name")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| "generated-frontend".to_string());
    let framework = match frontend_framework {
        None | Some("") => "vite".to_string(),
        Some(value) => value.to_string(),
    };
    Ok(Settings {
        application_name,
        frontend_framework: framework,
        full_stack: raw.get("application_tier").map(String::as_str) == Some("full-stack"),
        schema_version: raw
            .get("codegen.schema_version")
            .cloned()
            .unwrap_or_else(|| "1.0".to_string()),
        simple_doc: comments != Some("none") && comments != Some("description"),
        description_doc: comments == Some("description"),
        create_index: raw.get("codegen.create_index").map(String::as_str) != Some("false"),
        library_reference_mode: raw
            .get("languages.typescript.library_reference_mode")
            .cloned(),
    })
}
