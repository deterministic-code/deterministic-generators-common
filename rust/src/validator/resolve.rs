use std::path::{Path, PathBuf};

const SPEC_REPO: &str = "deterministic-specifications";

fn file_exists(path: &Path) -> bool {
    path.exists()
}

pub fn spec_rel_path(subdir: &str, name: &str) -> String {
    Path::new(subdir).join(name).display().to_string()
}

pub fn find_ancestor_path(rel_path: &str, start: &Path) -> Option<PathBuf> {
    let mut current = start.to_path_buf();
    loop {
        let candidate = current.join(rel_path);
        if file_exists(&candidate) {
            return Some(candidate);
        }
        let sibling = current.join(SPEC_REPO).join(rel_path);
        if file_exists(&sibling) {
            return Some(sibling);
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return None,
        }
    }
}

pub fn find_spec_path(subdir: &str, name: &str, start: &Path) -> Option<PathBuf> {
    find_ancestor_path(&spec_rel_path(subdir, name), start)
}

pub fn resolve_spec_path(subdir: &str, name: &str, start: &Path) -> Result<PathBuf, String> {
    find_spec_path(subdir, name, start)
        .ok_or_else(|| format!("spec file not found: {}", spec_rel_path(subdir, name)))
}

pub fn default_start() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

pub const SPEC_FILES: &[(&str, &str)] = &[
    ("backend", "types.spec.yaml"),
    ("backend", "datasource.spec.yaml"),
    ("backend", "datasource-seeds.spec.yaml"),
    ("backend", "routes.spec.yaml"),
    ("backend", "routes-api.spec.yaml"),
    ("backend", "services.spec.yaml"),
    ("frontend", "bindings.spec.yaml"),
    ("backend", "app.spec.yaml"),
    ("backend", "field-types.spec.yaml"),
];
