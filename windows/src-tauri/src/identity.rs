// Who Mochi is talking to — the same rule as UserIdentity.swift.

use crate::platform;

/// A name longer than this is not something to greet anyone by.
const MAX_FULL_NAME: usize = 32;

/// First name of the account holder, or None when the account name is not
/// something you would greet someone by. "Théodore Riant" gives "Théodore"; a
/// login handle like "theodoreriant" or "t.riant2" gives None, because
/// "theodoreriant's assistant" reads worse than no name at all.
pub fn first_name() -> Option<String> {
    first_name_of(&platform::user_full_name()?)
}

fn first_name_of(full_name: &str) -> Option<String> {
    let full_name = full_name.trim();
    if full_name.is_empty() || full_name.chars().count() > MAX_FULL_NAME {
        return None;
    }
    if looks_like_login_handle(full_name) {
        return None;
    }
    let first = full_name.split(' ').find(|part| !part.is_empty())?;
    first.chars().all(is_name_part).then(|| first.to_string())
}

/// The system gives the short account name when no full name is set, so a
/// single lowercase word, or one carrying digits or separators, is a handle.
fn looks_like_login_handle(name: &str) -> bool {
    if name.contains(' ') {
        return false;
    }
    name == name.to_lowercase() || name.chars().any(is_handle_marker)
}

fn is_handle_marker(c: char) -> bool {
    c.is_numeric() || "._-@".contains(c)
}

fn is_name_part(c: char) -> bool {
    c.is_alphabetic() || c == '\'' || c == '-'
}

#[cfg(test)]
mod tests {
    use super::first_name_of;

    #[test]
    fn a_full_name_gives_its_first_name() {
        assert_eq!(first_name_of("Théodore Riant").as_deref(), Some("Théodore"));
        assert_eq!(first_name_of("  Ada Lovelace ").as_deref(), Some("Ada"));
        assert_eq!(first_name_of("Jean-Luc O'Neil").as_deref(), Some("Jean-Luc"));
    }

    #[test]
    fn a_login_handle_gives_none() {
        assert_eq!(first_name_of("theodoreriant"), None);
        assert_eq!(first_name_of("t.riant2"), None);
        assert_eq!(first_name_of("edu76"), None);
        assert_eq!(first_name_of(""), None);
    }

    #[test]
    fn a_single_capitalised_word_is_a_name() {
        assert_eq!(first_name_of("Louis").as_deref(), Some("Louis"));
    }

    #[test]
    fn a_name_too_long_or_with_odd_characters_gives_none() {
        assert_eq!(first_name_of("An Extraordinarily Long Account Name Indeed"), None);
        assert_eq!(first_name_of("R2 D2"), None);
    }
}
