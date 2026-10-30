//! Host-scoped, temporary Git credential helper for connected forge accounts.
use crate::clone::HttpsAuth;
use beebranch_core::AppError;

#[derive(Debug)]
pub(crate) struct CredentialHelper {
    directory: tempfile::TempDir,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl CredentialHelper {
    pub(crate) fn new(credentials: &[(String, HttpsAuth)]) -> Result<Self, AppError> {
        let directory = tempfile::tempdir().map_err(|e| AppError::internal(e.to_string()))?;
        let mut script = String::from(
            "#!/bin/sh\n[ \"$1\" = get ] || exit 0\nprotocol= host=\nwhile IFS= read -r line; do\n  [ -n \"$line\" ] || break\n  case \"$line\" in\n    protocol=*) protocol=${line#protocol=} ;;\n    host=*) host=${line#host=} ;;\n  esac\ndone\n[ \"$protocol\" = https ] || exit 0\ncase \"$host\" in\n"
        );
        for (index, (host, auth)) in credentials.iter().enumerate() {
            if host.is_empty()
                || host.contains(['/', '@', '\n', '\r', '\0'])
                || auth.username.contains(['\n', '\r', '\0'])
                || auth.token.contains(['\n', '\r', '\0'])
            {
                return Err(AppError::invalid_input(
                    "Identifiants HTTPS invalides.".to_owned(),
                ));
            }
            let path = directory.path().join(format!("credential-{index}"));
            let mut file = std::fs::OpenOptions::new();
            file.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                file.mode(0o600);
            }
            use std::io::Write;
            let mut file = file
                .open(&path)
                .map_err(|e| AppError::internal(e.to_string()))?;
            write!(
                file,
                "username={}\npassword={}\n\n",
                auth.username, auth.token
            )
            .map_err(|e| AppError::internal(e.to_string()))?;
            script.push_str(&format!(
                "  {}) cat {} ;;\n",
                quote(host),
                quote(&path.to_string_lossy().replace('\\', "/"))
            ));
        }
        script.push_str("esac\n");
        std::fs::write(directory.path().join("helper.sh"), script)
            .map_err(|e| AppError::internal(e.to_string()))?;
        Ok(Self { directory })
    }

    pub(crate) fn config(&self) -> String {
        format!(
            "credential.helper=!sh {}",
            quote(
                &self
                    .directory
                    .path()
                    .join("helper.sh")
                    .to_string_lossy()
                    .replace('\\', "/")
            )
        )
    }
}
