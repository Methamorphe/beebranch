//! Application preferences (UI state, external tools configuration).

use beebranch_core::AppError;
use serde::Deserialize;
use tauri::State;

use crate::error::store_error;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceSet {
    pub key: String,
    pub value: String,
}

fn validate_key(key: &str) -> Result<(), AppError> {
    if key.is_empty()
        || key.len() > 120
        || !key.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(AppError::invalid_input(format!(
            "clé de préférence invalide: {key:?}"
        )));
    }
    Ok(())
}

#[tauri::command]
pub fn preference_get(state: State<'_, AppState>, key: String) -> Result<Option<String>, AppError> {
    validate_key(&key)?;
    state.store.preference(&key).map_err(store_error)
}

#[tauri::command]
pub fn preference_set(state: State<'_, AppState>, input: PreferenceSet) -> Result<(), AppError> {
    validate_key(&input.key)?;
    if input.value.len() > 64 * 1024 {
        return Err(AppError::invalid_input(
            "valeur de préférence trop grande".to_owned(),
        ));
    }
    state
        .store
        .set_preference(&input.key, &input.value)
        .map_err(store_error)
}
