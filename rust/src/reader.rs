use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::Error;

/// Host-supplied access to the deterministic YAML tree (disk, memory, zip, …).
pub trait DeterministicReader {
    fn read(&self, name: &str) -> Result<String, Error>;
    fn exists(&self, name: &str) -> bool;
}

pub struct MemoryReader {
    files: HashMap<String, String>,
}

pub struct FileReader {
    dir: PathBuf,
}

pub fn memory_reader(files: HashMap<String, String>) -> MemoryReader {
    MemoryReader { files }
}

pub fn file_reader(root: impl AsRef<Path>) -> FileReader {
    FileReader {
        dir: absolute_dir(root.as_ref()),
    }
}

#[inline(never)]
fn absolute_dir(root: &Path) -> PathBuf {
    if root.is_absolute() {
        normalize(root)
    } else {
        normalize(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(root))
    }
}

#[inline(never)]
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

impl DeterministicReader for MemoryReader {
    #[inline(never)]
    fn read(&self, name: &str) -> Result<String, Error> {
        self.files
            .get(name)
            .cloned()
            .ok_or_else(|| Error::new(format!("deterministic reader: missing {name}")))
    }

    #[inline(never)]
    fn exists(&self, name: &str) -> bool {
        self.files.contains_key(name)
    }
}

impl DeterministicReader for FileReader {
    #[inline(never)]
    fn read(&self, name: &str) -> Result<String, Error> {
        let path = self.dir.join(name);
        fs::read_to_string(&path).map_err(|_| {
            Error::new(format!(
                "deterministic reader: missing {name} in {}",
                self.dir.display()
            ))
        })
    }

    #[inline(never)]
    fn exists(&self, name: &str) -> bool {
        self.dir.join(name).exists()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn memory_and_file_readers() {
        let mut files = HashMap::new();
        files.insert("types.yaml".into(), "ok".into());
        let mem = memory_reader(files);
        assert!(mem.exists("types.yaml"));
        assert_eq!(mem.read("types.yaml").unwrap(), "ok");
        assert!(!mem.exists("nope.yaml"));
        assert_eq!(
            mem.read("nope.yaml").unwrap_err().0,
            "deterministic reader: missing nope.yaml"
        );

        let dir = tempfile::tempdir().unwrap();
        let mut f = fs::File::create(dir.path().join("types.yaml")).unwrap();
        f.write_all(b"disk").unwrap();
        let abs = file_reader(dir.path());
        assert!(abs.exists("types.yaml"));
        assert_eq!(abs.read("types.yaml").unwrap(), "disk");
        assert!(!abs.exists("missing.yaml"));
        let err = abs.read("missing.yaml").unwrap_err().0;
        assert!(err.contains("missing missing.yaml"));

        let rel = file_reader(".");
        let _ = rel.exists("Cargo.toml");
        let nested = dir.path().join("a").join(".").join("b").join("..").join("c");
        fs::create_dir_all(&nested).unwrap();
        let _ = file_reader(&nested);
        let parented = dir.path().join("x").join("y").join("..");
        fs::create_dir_all(dir.path().join("x").join("y")).unwrap();
        let _ = file_reader(&parented);
    }
}
