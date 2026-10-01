// What Spotify is playing, with no key and no account: Windows already knows.
//
// Every player tells the system what it plays — it is what the volume flyout
// and the lock screen show — through the System Media Transport Controls.
// Asking Windows for Spotify's session gives the song, who plays it, whether
// it is playing or paused, and its cover, and lets it be paused or skipped.
// It is all local: nothing is asked of Spotify, nothing touches the network.
//
// Only the Spotify desktop app has a session of its own; Spotify in a browser
// tab is the browser's, and is not looked for.
//
// The idea of a keyless Spotify pill is corefusiion's (Louis-CFM/coucou#80),
// which read the window's title; this asks the system instead, which also
// knows the cover and a paused song.

use std::sync::Mutex;

use serde::Serialize;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Sessions,
    GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;

/// What marks a session as Spotify's, in the id of the app it belongs to:
/// "Spotify.exe" for the installer's build, "SpotifyAB.SpotifyMusic_…" for the Store's.
const SPOTIFY: &str = "spotify";
/// Largest cover handed to the island, in bytes. Spotify's are a few dozen kilobytes.
const MAX_COVER: u32 = 512 * 1024;

/// What Spotify is playing. `open` is false when the app has no session:
/// closed, or opened and never played since.
#[derive(Serialize, Clone, Default, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub open: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// The cover as a `data:` URL, when the system has one.
    pub cover: Option<String>,
}

/// The cover of the song last asked about: read once per song, not at every look.
static COVER: Mutex<Option<(String, String)>> = Mutex::new(None);

fn spotify() -> Option<Session> {
    let sessions = Sessions::RequestAsync().ok()?.get().ok()?.GetSessions().ok()?;
    sessions.into_iter().find(|session| {
        session.SourceAppUserModelId().is_ok_and(|id| id.to_string().to_lowercase().contains(SPOTIFY))
    })
}

pub fn now_playing() -> NowPlaying {
    let Some(session) = spotify() else { return NowPlaying::default() };
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .is_ok_and(|status| status == Status::Playing);
    let Ok(song) = session.TryGetMediaPropertiesAsync().and_then(|asked| asked.get()) else {
        return NowPlaying { open: true, playing, ..NowPlaying::default() };
    };
    let text = |value: windows::core::Result<windows::core::HSTRING>| value.map(|s| s.to_string()).unwrap_or_default();
    let (title, artist, album) = (text(song.Title()), text(song.Artist()), text(song.AlbumTitle()));
    let cover = if title.is_empty() { None } else { cover_of(&song, &format!("{artist}\n{album}\n{title}")) };
    NowPlaying { open: true, playing, title, artist, album, cover }
}

/// The song's cover, from the cache when it is the song last asked about. A
/// song whose cover is not there yet — it comes a moment after the song
/// changes — is asked again at the next look.
fn cover_of(song: &Properties, key: &str) -> Option<String> {
    if let Some((known, cover)) = COVER.lock().unwrap().as_ref() {
        if known == key {
            return Some(cover.clone());
        }
    }
    let cover = read_cover(song)?;
    *COVER.lock().unwrap() = Some((key.to_string(), cover.clone()));
    Some(cover)
}

fn read_cover(song: &Properties) -> Option<String> {
    let stream = song.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = u32::try_from(stream.Size().ok()?).ok().filter(|size| (1..=MAX_COVER).contains(size))?;
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(format!("data:{};base64,{}", image_type(&bytes)?, base64(&bytes)))
}

/// What kind of image these bytes are, by how they start. Anything else is
/// not shown: the island only ever draws what it knows to be a picture.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        _ => None,
    }
}

/// Standard base64, with padding. Written here rather than pulled in: it is
/// twenty lines, and the app takes no dependency it can do without.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().fold(0u32, |group, byte| (group << 8) | u32::from(*byte)) << (8 * (3 - chunk.len()));
        for place in 0..4 {
            if place <= chunk.len() {
                out.push(ALPHABET[((group >> (18 - 6 * place)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Play or pause, the next song, the one before: asked of Spotify's own
/// session, so it never goes to another player.
pub fn press(action: &str) -> Result<(), String> {
    let session = spotify().ok_or("Spotify has nothing to play yet")?;
    let asked = match action {
        "toggle" => session.TryTogglePlayPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        "previous" => session.TrySkipPreviousAsync(),
        _ => return Err("unknown media key".into()),
    };
    match asked.and_then(|asked| asked.get()) {
        Ok(true) => Ok(()),
        _ => Err("Spotify did not take it".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_the_standard_one() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xFF, 0xD8, 0xFF, 0xE0]), "/9j/4A==");
    }

    #[test]
    fn only_a_picture_is_shown_as_one() {
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]), Some("image/jpeg"));
        assert_eq!(image_type(&[0x89, b'P', b'N', b'G', 0x0D]), Some("image/png"));
        assert_eq!(image_type(b"<svg onload=alert(1)>"), None);
        assert_eq!(image_type(&[]), None);
    }
}
