//! Centralized redaction for process output, error details and logs.
//!
//! Credentials are replaced with `***`, non-secret text is preserved. The
//! same implementation is used by the Git engine, the GitLab client and the
//! diagnostic export, so there is exactly one redaction policy.

use std::borrow::Cow;

const QUERY_KEYS: [&str; 2] = ["access_token", "private_token"];
const HEADERS: [&str; 4] = ["authorization", "private-token", "job-token", "cookie"];

/// Redact credentials from `input`.
pub fn redact(input: &str) -> Cow<'_, str> {
    let output = redact_key_values(Cow::Borrowed(input), &QUERY_KEYS);
    let output = redact_headers(output);
    let output = redact_url_credentials(output);
    redact_forge_tokens(output)
}

/// Redact credentials from raw process output.
pub fn redact_bytes(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    redact(&text).into_owned()
}

/// Bound and redact a diagnostic string for storage or display.
pub fn redact_bounded(input: &str, max_chars: usize) -> String {
    let redacted = redact(input);
    redacted.chars().take(max_chars).collect()
}

fn redact_key_values<'a>(input: Cow<'a, str>, keys: &[&str]) -> Cow<'a, str> {
    let text: &str = input.as_ref();
    let mut output: Option<String> = None;
    let mut last = 0;
    let mut search_from = 0;

    while let Some((start, key_len)) = find_any_ci(text, search_from, keys) {
        if start > 0 && !is_word_boundary(text, start) {
            search_from = start + key_len;
            continue;
        }
        let mut value_start = start + key_len;
        if text.as_bytes().get(value_start) != Some(&b'=') {
            search_from = value_start;
            continue;
        }
        value_start += 1;
        let value_end = find_value_end(text, value_start);

        let out = output.get_or_insert_with(|| String::with_capacity(text.len() + 8));
        out.push_str(&text[last..value_start]);
        out.push_str("***");
        last = value_end;
        search_from = value_end;
    }

    match output {
        Some(mut out) => {
            out.push_str(&text[last..]);
            Cow::Owned(out)
        }
        None => input,
    }
}

fn redact_headers<'a>(input: Cow<'a, str>) -> Cow<'a, str> {
    let text: &str = input.as_ref();
    let mut output: Option<String> = None;
    let mut last = 0;
    let mut search_from = 0;

    while let Some((start, name_len)) = find_any_ci(text, search_from, &HEADERS) {
        if start > 0 && !is_word_boundary(text, start) {
            search_from = start + name_len;
            continue;
        }

        let mut colon = start + name_len;
        while matches!(text.as_bytes().get(colon), Some(b' ') | Some(b'\t')) {
            colon += 1;
        }
        if text.as_bytes().get(colon) != Some(&b':') {
            search_from = start + name_len;
            continue;
        }

        let value_start = colon + 1;
        let value_end = find_line_end(text, value_start);
        let out = output.get_or_insert_with(|| String::with_capacity(text.len() + 8));
        out.push_str(&text[last..value_start]);
        out.push_str(" ***");
        last = value_end;
        search_from = value_end;
    }

    match output {
        Some(mut out) => {
            out.push_str(&text[last..]);
            Cow::Owned(out)
        }
        None => input,
    }
}

fn redact_url_credentials<'a>(input: Cow<'a, str>) -> Cow<'a, str> {
    let text: &str = input.as_ref();
    let mut output: Option<String> = None;
    let mut last = 0;
    let mut search_from = 0;

    while let Some(relative) = text[search_from..].find("://") {
        let scheme_end = search_from + relative + 3;
        let authority_end = text[scheme_end..]
            .find(is_authority_delimiter)
            .map(|offset| scheme_end + offset)
            .unwrap_or(text.len());
        let authority = &text[scheme_end..authority_end];

        let Some(at) = authority.rfind('@') else {
            search_from = authority_end.max(scheme_end);
            if search_from == text.len() {
                break;
            }
            continue;
        };

        let userinfo_end = scheme_end + at;
        if userinfo_end == scheme_end {
            search_from = authority_end.max(scheme_end);
            continue;
        }

        let out = output.get_or_insert_with(|| String::with_capacity(text.len() + 8));
        out.push_str(&text[last..scheme_end]);
        out.push_str("***");
        last = userinfo_end;
        search_from = authority_end.max(userinfo_end);
    }

    match output {
        Some(mut out) => {
            out.push_str(&text[last..]);
            Cow::Owned(out)
        }
        None => input,
    }
}

fn redact_forge_tokens<'a>(input: Cow<'a, str>) -> Cow<'a, str> {
    // GitLab and GitHub personal access tokens. The prefix is replaced with
    // the token body so a truncated token never survives in a diagnostic.
    const PREFIXES: [&str; 12] = [
        "glpat-",
        "gloas-",
        "glrt-",
        "glcbt-",
        "glft-",
        "glptt-",
        "github_pat_",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
    ];

    let text: &str = input.as_ref();
    let mut output: Option<String> = None;
    let mut last = 0;
    let mut search_from = 0;

    while let Some((start, prefix_len)) = find_any_ci(text, search_from, &PREFIXES) {
        let token_start = start + prefix_len;
        let mut token_end = token_start;
        while let Some(character) = text[token_end..].chars().next() {
            if character.is_alphanumeric() || matches!(character, '_' | '-' | '.') {
                token_end += character.len_utf8();
            } else {
                break;
            }
        }
        if token_end == token_start {
            search_from = token_start;
            continue;
        }

        let out = output.get_or_insert_with(|| String::with_capacity(text.len() + 8));
        out.push_str(&text[last..start]);
        out.push_str("***");
        last = token_end;
        search_from = token_end;
    }

    match output {
        Some(mut out) => {
            out.push_str(&text[last..]);
            Cow::Owned(out)
        }
        None => input,
    }
}

fn find_any_ci(text: &str, from: usize, needles: &[&str]) -> Option<(usize, usize)> {
    needles
        .iter()
        .filter_map(|needle| find_ci(text, from, needle).map(|index| (index, needle.len())))
        .min_by_key(|(index, _)| *index)
}

fn find_ci(text: &str, from: usize, needle: &str) -> Option<usize> {
    let haystack = text.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() || from >= haystack.len() || haystack.len() - from < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len())
        .find(|&index| haystack[index..index + needle.len()].eq_ignore_ascii_case(needle))
}

fn is_word_boundary(text: &str, index: usize) -> bool {
    text[..index].chars().next_back().is_none_or(|character| {
        character.is_whitespace()
            || matches!(
                character,
                '"' | '\'' | '(' | '[' | '{' | ',' | ';' | '?' | '&' | '#'
            )
    })
}

fn find_value_end(text: &str, start: usize) -> usize {
    text[start..]
        .find(|character: char| {
            matches!(
                character,
                '&' | ' ' | '\t' | '\r' | '\n' | '"' | '\'' | '#' | ';'
            )
        })
        .map(|offset| start + offset)
        .unwrap_or(text.len())
}

fn find_line_end(text: &str, start: usize) -> usize {
    text[start..]
        .find(['\r', '\n'])
        .map(|offset| start + offset)
        .unwrap_or(text.len())
}

fn is_authority_delimiter(character: char) -> bool {
    matches!(
        character,
        '/' | '?' | '#' | ' ' | '\t' | '\r' | '\n' | '"' | '\''
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_userinfo_in_urls() {
        let input = "fatal: https://oauth2:glpat-abc123@gitlab.example.com/group/repo.git";
        let output = redact(input);
        assert!(!output.contains("glpat-abc123"));
        assert!(output.contains("https://***@gitlab.example.com/group/repo.git"));
    }

    #[test]
    fn redacts_headers_case_insensitively() {
        let input = "PRIVATE-TOKEN: glpat-abc123\nAuthorization: Bearer token-value\nok\n";
        let output = redact(input);
        assert!(!output.contains("glpat-abc123"));
        assert!(!output.contains("token-value"));
        assert!(output.contains("PRIVATE-TOKEN: ***"));
        assert!(output.contains("Authorization: ***"));
        assert!(output.contains("ok"));
    }

    #[test]
    fn redacts_query_parameters() {
        let input = "https://example.test/cb?access_token=abc&private_token=def&keep=1";
        let output = redact(input);
        assert!(!output.contains("abc"));
        assert!(!output.contains("def"));
        assert!(output.contains("access_token=***"));
        assert!(output.contains("private_token=***"));
        assert!(output.contains("keep=1"));
    }

    #[test]
    fn redacts_forge_tokens_everywhere() {
        assert_eq!(redact("token glpat-AbC_123-xyz end"), "token *** end");
        assert_eq!(redact("token glrt-AbC_123 end"), "token *** end");
        assert_eq!(redact("token ghp_AbC123 end"), "token *** end");
        assert_eq!(redact("token github_pat_11ABC_def end"), "token *** end");
    }

    #[test]
    fn preserves_text_without_secrets() {
        let input = "nothing sensitive here\n";
        assert!(matches!(redact(input), Cow::Borrowed(_)));
        assert_eq!(redact(input), input);
    }

    #[test]
    fn handles_multibyte_text() {
        let output = redact("échec: https://user:pass@hôte.test/repo — glpat-é");
        assert!(output.contains("échec"));
        assert!(output.contains("https://***@hôte.test/repo"));
        assert!(!output.contains("pass"));
        assert!(!output.contains("glpat-é"));
    }

    #[test]
    fn bounds_diagnostic_output() {
        let bounded = redact_bounded(&"a".repeat(100), 10);
        assert_eq!(bounded.len(), 10);
    }
}
