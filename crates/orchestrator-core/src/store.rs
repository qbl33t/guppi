//! Store — thin file persistence (atomic write via tmp+rename). Deliberately
//! not a DB abstraction; revisit only if contention shows. Layout matches the
//! architecture note: `cases/`, `rules.json`, `events.json`, `flows/`, etc.

use std::path::Path;

/// Serialize `value` as pretty JSON and write atomically (write tmp, rename).
pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> crate::Result<()> {
    let json = serde_json::to_vec_pretty(value)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json).map_err(|e| crate::CoreError::Io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| crate::CoreError::Io(e.to_string()))?;
    Ok(())
}

/// Read + deserialize JSON.
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> crate::Result<T> {
    let bytes = std::fs::read(path).map_err(|e| crate::CoreError::Io(e.to_string()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Atomic raw byte write (tmp + rename). Used for config.toml.
pub fn write_json_raw(path: &Path, bytes: &[u8]) -> crate::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| crate::CoreError::Io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| crate::CoreError::Io(e.to_string()))?;
    Ok(())
}
