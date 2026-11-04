//! Claude Code's on-disk project layout.

/// Longest project directory name Claude Code writes before shortening it.
const MAX_PROJECT_KEY: usize = 200;

/// The directory name Claude Code uses under `projects/` for a working directory.
///
/// Claude Code replaces every UTF-16 code unit that is not an ASCII letter or
/// digit with `-`. A name longer than 200 characters keeps its first 200 and
/// gains `-` plus the base-36 absolute value of a 32-bit djb2 hash of the
/// original working directory, so long scratch and worktree paths live in a
/// shortened directory rather than the full sanitized name.
pub fn project_key(cwd: &str) -> String {
    let sanitized = cwd
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_string()
            } else {
                "-".repeat(c.len_utf16())
            }
        })
        .collect::<String>();
    if sanitized.len() <= MAX_PROJECT_KEY {
        return sanitized;
    }
    let hash = cwd.encode_utf16().fold(0i32, |hash, unit| {
        (hash << 5).wrapping_sub(hash).wrapping_add(i32::from(unit))
    });
    format!(
        "{}-{}",
        &sanitized[..MAX_PROJECT_KEY],
        base36(i64::from(hash).unsigned_abs())
    )
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(char::from_digit((value % 36) as u32, 36).unwrap());
        value /= 36;
    }
    digits.iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_paths_keep_the_full_sanitized_name() {
        assert_eq!(project_key("/Users/me/my project"), "-Users-me-my-project");
        // Characters outside the BMP are two UTF-16 code units.
        assert_eq!(project_key("/a/😀b"), "-a---b");
    }

    #[test]
    fn long_paths_match_claude_code_shortened_directories() {
        // Observed native directory for a Claude Desktop scratch workspace.
        let cwd = "/private/tmp/claude-501/-Users-jamie-Library-Application-Support-Claude-scratch-workspaces-38950a8c-04d0-4d63-b282-143cf6afe921-75bcb663-1e5b-4b2d-a0f4-12af1aa0e6ae-scratch-2026-11-03-5f7bcd/fc4b8542-c828-445a-b293-b32eba8151f1/scratchpad/wd-smoke/codex";
        assert_eq!(
            project_key(cwd),
            "-private-tmp-claude-501--Users-jamie-Library-Application-Support-Claude-scratch-workspaces-38950a8c-04d0-4d63-b282-143cf6afe921-75bcb663-1e5b-4b2d-a0f4-12af1aa0e6ae-scratch-2026-11-03-5f7bcd-fc4b8542--ay3dsg"
        );
        let exact = format!("/{}", "a".repeat(199));
        assert_eq!(project_key(&exact).len(), 200);
        assert!(project_key(&format!("{exact}b")).starts_with(&format!("-{}", "a".repeat(199))));
        assert_eq!(base36(2_147_483_648), "zik0zk");
    }
}
