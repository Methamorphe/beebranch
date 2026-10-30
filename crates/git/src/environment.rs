use std::collections::BTreeMap;
use std::ffi::OsString;

use crate::error::GitError;

/// Variables inherited from the user's environment.
///
/// The list is a strict allowlist: everything else is dropped. It keeps Git
/// usable (PATH, HOME, SSH agent, proxies, TLS stores) without inheriting
/// repo-hijacking variables or trace sinks that could leak output.
const ALLOWED: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LANGUAGE",
    "TERM",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "GNUPGHOME",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "GIT_ASKPASS",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_ALLOW_PROTOCOL",
    "GIT_SSH_VARIANT",
    "PLINK_PROTOCOL",
    "DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "KRB5CCNAME",
    "KRB5_CONFIG",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    "USERNAME",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "LOGONSERVER",
    "SESSIONNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERPROFILE",
    "HOMESHARE",
    "PUBLIC",
    "ONEDRIVE",
];

/// Variables forced to a fixed value, regardless of the inherited environment
/// or per-command overrides.
const FORCED: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_PAGER", "cat"),
    ("PAGER", "cat"),
];

/// Build the process environment from the inherited environment and the
/// per-command overrides.
pub(crate) fn prepare(
    extra: &[(OsString, OsString)],
) -> Result<Vec<(OsString, OsString)>, GitError> {
    build(std::env::vars_os(), extra)
}

/// Variables a per-command override may still not set.
///
/// `GIT_CONFIG_*` is how the commit path hands configuration to Git (one entry
/// per key); the inherited environment cannot smuggle those in — `is_blocked`
/// drops them there — but a spec built by this crate may set them. The
/// variables that would redirect Git to another file stay forbidden.
fn is_blocked_override(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if upper == "GIT_CONFIG_COUNT"
        || upper.starts_with("GIT_CONFIG_KEY_")
        || upper.starts_with("GIT_CONFIG_VALUE_")
    {
        return false;
    }
    is_blocked(name)
}

/// Validate per-command environment overrides before building the map.
pub(crate) fn validate_extra(extra: &[(OsString, OsString)]) -> Result<(), GitError> {
    for (name, _) in extra {
        let Some(text) = name.to_str() else {
            return Err(GitError::invalid_environment(
                "nom de variable non UTF-8".to_owned(),
            ));
        };
        if text.is_empty() || text.contains('=') || text.contains('\0') {
            return Err(GitError::invalid_environment(format!(
                "nom de variable invalide : {text:?}"
            )));
        }
        if is_blocked_override(text) {
            return Err(GitError::invalid_environment(format!(
                "variable interdite : {text}"
            )));
        }
    }
    Ok(())
}

fn build<I>(
    inherited: I,
    extra: &[(OsString, OsString)],
) -> Result<Vec<(OsString, OsString)>, GitError>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    validate_extra(extra)?;

    let mut environment: BTreeMap<String, (OsString, OsString)> = BTreeMap::new();

    for (name, value) in inherited {
        let Some(text) = name.to_str() else {
            continue;
        };
        if !is_allowed(text) || is_blocked(text) {
            continue;
        }
        environment.insert(canonical_key(text), (name, value));
    }

    for (name, value) in extra {
        let text = name
            .to_str()
            .ok_or_else(|| GitError::invalid_environment("nom de variable non UTF-8"))?;
        environment.insert(canonical_key(text), (name.clone(), value.clone()));
    }

    for (name, value) in FORCED {
        environment.insert(
            (*name).to_owned(),
            (OsString::from(name), OsString::from(value)),
        );
    }

    Ok(environment.into_values().collect())
}

fn canonical_key(name: &str) -> String {
    name.to_ascii_uppercase()
}

fn is_allowed(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    if upper.starts_with("LC_") {
        return true;
    }
    ALLOWED.iter().any(|allowed| upper == *allowed)
}

fn is_blocked(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();

    upper == "GIT_CONFIG"
        || upper == "GIT_CONFIG_GLOBAL"
        || upper == "GIT_CONFIG_SYSTEM"
        || upper == "GIT_CONFIG_COUNT"
        || upper.starts_with("GIT_CONFIG_KEY_")
        || upper.starts_with("GIT_CONFIG_VALUE_")
        || upper.starts_with("GIT_TRACE")
        || matches!(
            upper.as_str(),
            "GIT_DIR"
                | "GIT_WORK_TREE"
                | "GIT_COMMON_DIR"
                | "GIT_INDEX_FILE"
                | "GIT_OBJECT_DIRECTORY"
                | "GIT_ALTERNATE_OBJECT_DIRECTORIES"
                | "GIT_NAMESPACE"
                | "GIT_CEILING_DIRECTORIES"
                | "GIT_DISCOVERY_ACROSS_FILESYSTEM"
                | "GIT_EXTERNAL_DIFF"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(values: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        values
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    fn find<'a>(environment: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsString> {
        environment
            .iter()
            .find(|(key, _)| {
                key.to_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case(name))
            })
            .map(|(_, value)| value)
    }

    #[test]
    fn keeps_allowlisted_variables() {
        let environment = build(
            pairs(&[
                ("PATH", "/usr/bin"),
                ("HOME", "/home/test"),
                ("LC_ALL", "C"),
                ("SSH_AUTH_SOCK", "/tmp/agent"),
            ]),
            &[],
        )
        .expect("build");

        assert_eq!(
            find(&environment, "PATH").and_then(|v| v.to_str()),
            Some("/usr/bin")
        );
        assert_eq!(
            find(&environment, "HOME").and_then(|v| v.to_str()),
            Some("/home/test")
        );
        assert_eq!(
            find(&environment, "LC_ALL").and_then(|v| v.to_str()),
            Some("C")
        );
        assert!(find(&environment, "SSH_AUTH_SOCK").is_some());
    }

    #[test]
    fn drops_injection_and_hijack_variables() {
        let environment = build(
            pairs(&[
                ("GIT_DIR", "/evil"),
                ("GIT_WORK_TREE", "/evil"),
                ("GIT_INDEX_FILE", "/evil/index"),
                ("GIT_CONFIG_COUNT", "1"),
                ("GIT_CONFIG_KEY_0", "core.pager"),
                ("GIT_CONFIG_VALUE_0", "sh -c evil"),
                ("GIT_TRACE", "1"),
                ("GIT_EXTERNAL_DIFF", "evil"),
                ("LD_PRELOAD", "/evil.so"),
            ]),
            &[],
        )
        .expect("build");

        for name in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_TRACE",
            "GIT_EXTERNAL_DIFF",
            "LD_PRELOAD",
        ] {
            assert!(find(&environment, name).is_none(), "{name} must be dropped");
        }
    }

    #[test]
    fn forces_non_interactive_settings() {
        let environment = build(
            pairs(&[
                ("GIT_TERMINAL_PROMPT", "1"),
                ("GIT_PAGER", "less"),
                ("PAGER", "less"),
            ]),
            &[],
        )
        .expect("build");

        assert_eq!(
            find(&environment, "GIT_TERMINAL_PROMPT").and_then(|v| v.to_str()),
            Some("0")
        );
        assert_eq!(
            find(&environment, "GIT_PAGER").and_then(|v| v.to_str()),
            Some("cat")
        );
        assert_eq!(
            find(&environment, "PAGER").and_then(|v| v.to_str()),
            Some("cat")
        );
    }

    #[test]
    fn per_command_variables_are_allowed_unless_blocked() {
        let environment = build(
            pairs(&[]),
            &pairs(&[
                ("GIT_SEQUENCE_EDITOR", "/tmp/helper"),
                ("GIT_EDITOR", "/tmp/editor"),
            ]),
        )
        .expect("build");

        assert_eq!(
            find(&environment, "GIT_SEQUENCE_EDITOR").and_then(|v| v.to_str()),
            Some("/tmp/helper")
        );
        assert_eq!(
            find(&environment, "GIT_EDITOR").and_then(|v| v.to_str()),
            Some("/tmp/editor")
        );
    }

    #[test]
    fn blocked_per_command_variables_are_rejected() {
        let error = build(pairs(&[]), &pairs(&[("GIT_DIR", "/evil")])).expect_err("must reject");
        assert_eq!(error.code(), crate::GitErrorCode::InvalidEnvironment);
        assert!(error.detail().is_some());
    }

    #[test]
    fn per_command_config_overrides_reach_git() {
        let environment = build(
            pairs(&[("GIT_CONFIG_COUNT", "7")]),
            &pairs(&[
                ("GIT_CONFIG_COUNT", "1"),
                ("GIT_CONFIG_KEY_0", "core.hooksPath"),
                ("GIT_CONFIG_VALUE_0", "/tmp/hooks"),
            ]),
        )
        .expect("build");

        // The spec wins over an inherited value, which is dropped instead.
        assert_eq!(
            find(&environment, "GIT_CONFIG_COUNT").and_then(|v| v.to_str()),
            Some("1")
        );
        assert_eq!(
            find(&environment, "GIT_CONFIG_KEY_0").and_then(|v| v.to_str()),
            Some("core.hooksPath")
        );
        assert_eq!(
            find(&environment, "GIT_CONFIG_VALUE_0").and_then(|v| v.to_str()),
            Some("/tmp/hooks")
        );
    }

    #[test]
    fn forced_values_win_over_per_command_overrides() {
        let environment = build(
            pairs(&[]),
            &pairs(&[("GIT_TERMINAL_PROMPT", "1"), ("GIT_PAGER", "less")]),
        )
        .expect("build");

        assert_eq!(
            find(&environment, "GIT_TERMINAL_PROMPT").and_then(|v| v.to_str()),
            Some("0")
        );
        assert_eq!(
            find(&environment, "GIT_PAGER").and_then(|v| v.to_str()),
            Some("cat")
        );
    }
}
