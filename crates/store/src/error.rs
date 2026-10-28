use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("erreur SQLite: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("erreur d'entrée/sortie: {0}")]
    Io(#[from] std::io::Error),
    #[error("erreur de keychain: {0}")]
    Keychain(#[from] keyring::Error),
    #[error("données invalides: {0}")]
    Invalid(String),
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Database(_) => "store.database",
            Self::Io(_) => "store.io",
            Self::Keychain(_) => "store.keychain",
            Self::Invalid(_) => "store.invalid",
        }
    }

    /// Redacted detail suitable for an `AppError`.
    pub fn detail(&self) -> String {
        beebranch_core::redaction::redact_bounded(&self.to_string(), 4096)
    }
}
