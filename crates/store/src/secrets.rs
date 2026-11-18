use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::StoreError;

/// Secret storage abstraction.
///
/// The production implementation is the OS keychain. Tests use an in-memory
/// store so CI never depends on a desktop session keyring.
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError>;
    fn get(&self, account: &str) -> Result<Option<String>, StoreError>;
    fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// OS keychain implementation (`beebranch.gitlab` service by default).
pub struct KeychainStore {
    service: String,
}

impl KeychainStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    pub fn default_service() -> Self {
        Self::new("beebranch.gitlab")
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(&self.service, account).map_err(StoreError::from)
    }
}

impl SecretStore for KeychainStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError> {
        self.entry(account)?.set_password(secret)?;
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        match self.entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(StoreError::from(error)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(StoreError::from(error)),
        }
    }
}

/// File-backed secret store used only by development builds.
///
/// macOS ties a keychain item's ACL to the binary's code signature. Every
/// rebuild of a debug binary changes that signature, so "Always Allow" is
/// forgotten at the next launch. Development builds therefore keep secrets in
/// a 0600 JSON file inside the application data directory; release builds keep
/// using the OS keychain.
pub struct FileSecretStore {
    path: PathBuf,
    gate: Mutex<()>,
}

impl FileSecretStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            gate: Mutex::new(()),
        }
    }

    fn read_all(&self) -> Result<HashMap<String, String>, StoreError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(error) => return Err(StoreError::Io(error)),
        };
        if bytes.is_empty() {
            return Ok(HashMap::new());
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| StoreError::Invalid(format!("secrets invalides : {error}")))
    }

    fn write_all(&self, values: &HashMap<String, String>) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(values)
            .map_err(|error| StoreError::Invalid(format!("secrets : {error}")))?;
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(
            ".secrets-{}-{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&temporary, &bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
        }
        let replaced = match std::fs::rename(&temporary, &self.path) {
            Ok(()) => Ok(()),
            Err(_error) if cfg!(windows) && self.path.exists() => {
                std::fs::remove_file(&self.path)?;
                std::fs::rename(&temporary, &self.path)
            }
            Err(error) => Err(error),
        };
        if replaced.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        replaced.map_err(StoreError::Io)
    }
}

impl SecretStore for FileSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| StoreError::Invalid("secret store empoisonné".into()))?;
        let mut values = self.read_all()?;
        values.insert(account.to_owned(), secret.to_owned());
        self.write_all(&values)
    }

    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| StoreError::Invalid("secret store empoisonné".into()))?;
        Ok(self.read_all()?.remove(account))
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        let _guard = self
            .gate
            .lock()
            .map_err(|_| StoreError::Invalid("secret store empoisonné".into()))?;
        let mut values = self.read_all()?;
        if values.remove(account).is_some() {
            self.write_all(&values)?;
        }
        Ok(())
    }
}

/// File store first, OS keychain second.
///
/// macOS binds a keychain item to the creating binary's signature. A new
/// version of BeeBranch can therefore fail to read or update the item, which
/// used to look like a missing token and forced a reconnect. The file in the
/// application data directory is stable across versions; the keychain is kept
/// as a mirror when it accepts the write.
pub struct DurableSecretStore {
    file: std::sync::Arc<FileSecretStore>,
    keychain: KeychainStore,
    write_keychain: bool,
}

impl DurableSecretStore {
    pub fn new(
        file: std::sync::Arc<FileSecretStore>,
        service: impl Into<String>,
        write_keychain: bool,
    ) -> Self {
        Self {
            file,
            keychain: KeychainStore::new(service),
            write_keychain,
        }
    }
}

impl SecretStore for DurableSecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError> {
        self.file.set(account, secret)?;
        if self.write_keychain {
            if let Err(error) = self.keychain.set(account, secret) {
                tracing::warn!(
                    %error,
                    %account,
                    "trousseau non mis à jour ; le fichier reste la référence"
                );
            }
        }
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        if let Some(secret) = self.file.get(account)? {
            return Ok(Some(secret));
        }
        match self.keychain.get(account) {
            Ok(Some(secret)) => {
                if let Err(error) = self.file.set(account, &secret) {
                    tracing::warn!(%error, %account, "copie du secret hors du trousseau impossible");
                }
                Ok(Some(secret))
            }
            Ok(None) => Ok(None),
            Err(error) => {
                tracing::warn!(%error, %account, "lecture du trousseau refusée");
                Err(error)
            }
        }
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.file.delete(account)?;
        if self.write_keychain {
            let _ = self.keychain.delete(account);
        }
        Ok(())
    }
}

/// In-memory secret store used by tests.
#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreError> {
        self.values
            .lock()
            .map_err(|_| StoreError::Invalid("secret store empoisonné".into()))?
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .values
            .lock()
            .map_err(|_| StoreError::Invalid("secret store empoisonné".into()))?
            .get(account)
            .cloned())
    }

    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.values
            .lock()
            .map_err(|_| StoreError::Invalid("secret store empoisonné".into()))?
            .remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrips_and_deletes() {
        let store = MemorySecretStore::new();
        store.set("a", "one").expect("set");
        assert_eq!(store.get("a").expect("get").as_deref(), Some("one"));
        store.delete("a").expect("delete");
        assert_eq!(store.get("a").expect("get"), None);
    }

    #[test]
    fn file_store_roundtrips_with_restricted_permissions() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("secrets.json");
        let store = FileSecretStore::new(&path);
        assert_eq!(store.get("account").expect("empty"), None);
        store.set("account", "glpat-secret").expect("set");
        assert_eq!(
            FileSecretStore::new(&path)
                .get("account")
                .expect("get")
                .as_deref(),
            Some("glpat-secret")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        store.delete("account").expect("delete");
        assert_eq!(store.get("account").expect("get"), None);
    }

    #[test]
    fn durable_store_keeps_the_file_when_the_keychain_is_not_written() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("secrets.json");
        let file = std::sync::Arc::new(FileSecretStore::new(&path));
        let store = DurableSecretStore::new(file, "beebranch.test", false);
        store.set("gitlab.com#instance#oauth", "blob").expect("set");
        assert_eq!(
            DurableSecretStore::new(
                std::sync::Arc::new(FileSecretStore::new(&path)),
                "beebranch.test",
                false,
            )
            .get("gitlab.com#instance#oauth")
            .expect("get")
            .as_deref(),
            Some("blob")
        );
        store.delete("gitlab.com#instance#oauth").expect("delete");
        assert_eq!(
            FileSecretStore::new(&path)
                .get("gitlab.com#instance#oauth")
                .expect("get"),
            None
        );
    }
}
