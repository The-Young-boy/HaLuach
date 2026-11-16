// The radio: a WinRT MediaPlayer inside the provider process, so it keeps playing with the board closed.
// Windows' media panel (SMTC: media keys, the volume flyout, the lock screen) shows the station and the song,
// and its play/pause/next/previous buttons work. A dropped stream reconnects by itself. A sleep timer fades out.
// The page drives it: /board/radio?do=play&url=&name=&art=  |  do=stop | do=volume&v=0..1 | do=sleep&min= | do=nowplaying&title=
// The station list and "now playing" polling live in the page (it has the per-station parsers); next/previous
// from the media keys are queued here and read by the page (/board/radio answers {"want":"next"}).
// Shabbat and yom tov (cards.radio.stopOnCandles, default on): the radio stops at candle lighting and does not start
// until nightfall (quiet.json from the page). Headphones: the radio stops when the default output stops being
// headphones, and plays again if they come back within cards.radio.resumeMin minutes.
use crate::bindings::*;
use crate::log;
use serde_json::json;
use std::sync::Mutex;
use windows_core::HSTRING;

struct R {
    player: Option<MediaPlayer>,
    url: String,
    name: String,
    art: String,
    title: String,
    volume: f64,
    playing: bool,
    want: String,       // "next" | "prev" from the media keys, for the page
    sleep_at: u64,      // unix secs; 0 = off
    muted_for: String,  // why the radio is muted for a while ("alert"), empty = not
    list: Vec<(String, String, String)>, // (url, name, art): the order next/previous walk, from the page
    refused: bool,      // the last play was refused (shabbat or yom tov), for the page
    unplugged: Option<(String, u64, String)>, // stopped by the headphones going: (the device, unix secs, the url)
    item: Option<MediaPlaybackItem>, // what plays: the media panel shows its display properties
}
static R_: Mutex<R> = Mutex::new(R { player: None, url: String::new(), name: String::new(), art: String::new(), title: String::new(), volume: 0.8, playing: false, want: String::new(), sleep_at: 0, muted_for: String::new(), list: Vec::new(), refused: false, unplugged: None, item: None });

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn player(r: &mut R) -> windows_core::Result<MediaPlayer> {
    if let Some(p) = &r.player { return Ok(p.clone()) }
    let p = MediaPlayer::new()?;
    p.SetAudioCategory(MediaPlayerAudioCategory::Media)?;
    // The media panel's buttons. MediaPlayer's command manager (on by default) owns the panel: it answers the
    // buttons and shows the playing item (show()). Handled = true: the player does not pause or skip by itself;
    // every start still goes through play_url (shabbat). Next/previous: enabled always (one item, no list).
    let cm = p.CommandManager()?;
    cm.SetIsEnabled(true)?;
    cm.PlayBehavior()?.SetEnablingRule(MediaCommandEnablingRule::Always)?;
    cm.PauseBehavior()?.SetEnablingRule(MediaCommandEnablingRule::Always)?;
    cm.NextBehavior()?.SetEnablingRule(MediaCommandEnablingRule::Always)?;
    cm.PreviousBehavior()?.SetEnablingRule(MediaCommandEnablingRule::Always)?;
    cm.PlayReceived(|_, a| {
        if let Some(a) = a.as_ref() { let _ = a.SetHandled(true); }
        std::thread::spawn(|| { let u = R_.lock().unwrap().url.clone(); let _ = play_url(&u); });
    })?.forget(); // the player lives as long as the process (a dropped revoker unregisters at once)
    cm.PauseReceived(|_, a| {
        if let Some(a) = a.as_ref() { let _ = a.SetHandled(true); }
        std::thread::spawn(stop);
    })?.forget();
    cm.NextReceived(|_, a| {
        if let Some(a) = a.as_ref() { let _ = a.SetHandled(true); }
        std::thread::spawn(|| key_step(true));
    })?.forget();
    cm.PreviousReceived(|_, a| {
        if let Some(a) = a.as_ref() { let _ = a.SetHandled(true); }
        std::thread::spawn(|| key_step(false));
    })?.forget();
    // Stop has no command-manager event: it comes as a plain button.
    let smtc = p.SystemMediaTransportControls()?;
    smtc.SetIsStopEnabled(true)?;
    smtc.ButtonPressed(|_, a| {
        if a.as_ref().and_then(|a| a.Button().ok()) == Some(SystemMediaTransportControlsButton::Stop) { std::thread::spawn(stop); }
    })?.forget();
    // A stream that drops: try again after 3 seconds, up to 10 times in a row (a station that is down stays stopped).
    p.MediaFailed(|_, a| {
        let msg = a.as_ref().and_then(|a| a.ErrorMessage().ok()).map(|m| m.to_string_lossy()).unwrap_or_default();
        log(&format!("radio: failed: {msg}"));
        std::thread::spawn(retry);
    })?.forget();
    r.player = Some(p.clone());
    devices();
    Ok(p)
}

fn retry() {
    static TRIES: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = TRIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    if n >= 10 { TRIES.store(0, std::sync::atomic::Ordering::Relaxed); stop(); return }
    std::thread::sleep(std::time::Duration::from_secs(3));
    let (url, playing) = { let r = R_.lock().unwrap(); (r.url.clone(), r.playing) };
    if playing && !url.is_empty() { let _ = play_url(&url); }
}

/// The media panel: the song (or the station) over the station, with the station's art. The command manager
/// reads them from the playing item, so they are set on it (again for every new song).
fn show(r: &R) -> windows_core::Result<()> {
    let Some(item) = &r.item else { return Ok(()) };
    let d = item.GetDisplayProperties()?;
    d.SetType(MediaPlaybackType::Music)?;
    let m = d.MusicProperties()?;
    m.SetTitle(&HSTRING::from(if r.title.is_empty() { &r.name } else { &r.title }))?;
    m.SetArtist(&HSTRING::from(&r.name))?;
    // A packaged logo comes from the page as "station?id=<id>" (its /board/ route); the flyout reads the file itself.
    let art = match r.art.strip_prefix("station?id=") { Some(id) => format!("ms-appx:///Images/stations/{id}.png"), None => r.art.clone() };
    if art.starts_with("https://") || art.starts_with("ms-appx:///") {
        d.SetThumbnail(&RandomAccessStreamReference::CreateFromUri(&Uri::CreateUri(&HSTRING::from(&art))?)?)?;
    }
    item.ApplyDisplayProperties(&d)
}

/// Every start goes through here (the page, the widget, the media keys, a retry, an alarm, the headphones), so this
/// is the one place that refuses on shabbat and yom tov. A refusal is not an error: nothing plays, the page sees "quiet".
fn play_url(url: &str) -> windows_core::Result<()> {
    if blocked() {
        let playing = { let mut r = R_.lock().unwrap(); r.refused = true; r.url = url.to_string(); r.playing };
        if playing { stop(); }
        log_once("radio: play refused (shabbat or yom tov)");
        return Ok(())
    }
    let res = (|| {
        let mut r = R_.lock().unwrap();
        let p = player(&mut r)?;
        let item = MediaPlaybackItem::Create(&MediaSource::CreateFromUri(&Uri::CreateUri(&HSTRING::from(url))?)?)?;
        r.item = Some(item.clone());
        if let Err(e) = show(&r) { log(&format!("radio: display: {e}")); } // before SetSource: the panel takes it from the start
        p.SetSource(&item)?;
        p.SetVolume(r.volume)?;
        p.Play()?;
        r.url = url.to_string();
        r.playing = true;
        r.refused = false;
        r.unplugged = None;
        Ok(())
    })();
    clock(); // the candle-lighting check runs in its loop
    res
}

pub fn stop() {
    let mut r = R_.lock().unwrap();
    if let Some(p) = &r.player { let _ = p.Pause(); let _ = p.SetSource(None); }
    r.item = None;
    r.playing = false;
    r.sleep_at = 0;
    r.unplugged = None; // a stop by hand: replugging the headphones does not start it again
}

// ---------- shabbat and yom tov ----------
fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

/// Inside one of the windows (candle lighting to nightfall, unix ms)? A window that is empty, reversed or longer than
/// four days (the longest is yom tov next to shabbat, three days) is a broken file, not a reason to stay silent.
fn in_quiet(w: &[(i64, i64)], now: i64) -> bool {
    const MAX: i64 = 4 * 24 * 3600 * 1000;
    w.iter().any(|&(a, b)| b > a && b - a <= MAX && now >= a && now < b)
}

fn radio_cfg() -> serde_json::Value {
    let s: serde_json::Value = std::fs::read(crate::data_dir().join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    s["cards"]["radio"].clone()
}

/// The radio may not play now: inside a window, and the user's switch is on (default on). No quiet.json = never blocked.
fn blocked() -> bool {
    let w: Vec<(i64, i64)> = std::fs::read(crate::data_dir().join("quiet.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    in_quiet(&w, now_ms()) && radio_cfg()["stopOnCandles"].as_bool().unwrap_or(true)
}

/// The same refusal comes again and again (the page, the media keys): one log line per 10 minutes is enough.
fn log_once(msg: &str) {
    static LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let t = now();
    if t.saturating_sub(LAST.load(std::sync::atomic::Ordering::Relaxed)) >= 600 { LAST.store(t, std::sync::atomic::Ordering::Relaxed); log(msg); }
}

// ---------- headphones ----------
// MediaDevice.DefaultAudioRenderDeviceChanged: the default output changed. Its form factor (PKEY_AudioEndpoint_FormFactor:
// 3 headphones, 5 headset) tells headphones from speakers. A wired jack on a combined "speakers/headphones" endpoint
// (many Realtek laptops) does not change the default device, so Windows sends nothing and the radio keeps playing.
const FORM_FACTOR: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e} 0";

struct Dev { id: String, hp: Option<bool> } // hp: None = the form factor could not be read
static DEV: Mutex<Option<Dev>> = Mutex::new(None);

fn headphones(id: &str) -> (Option<bool>, String) {
    let r = (|| -> windows_core::Result<(Option<bool>, String)> {
        let props = windows_collections::IIterable::<HSTRING>::from(vec![HSTRING::from(FORM_FACTOR)]);
        let d = DeviceInformation::CreateFromIdAsyncAdditionalProperties(&HSTRING::from(id), &props)?.join()?;
        let name = d.Name().map(|n| n.to_string_lossy()).unwrap_or_default();
        let ff = d.Properties()?.Lookup(&HSTRING::from(FORM_FACTOR)).ok()
            .and_then(|v| windows_core::Interface::cast::<windows_reference::IReference<u32>>(&v).ok())
            .and_then(|v| v.Value().ok());
        Ok((ff.map(|f| f == 3 || f == 5), name))
    })();
    r.unwrap_or((None, String::new()))
}

/// What a change of the default output does. `prev`/`new`: headphones? (None = unknown).
/// Stop: playing, and the output went from headphones (or unknown) to something that is not headphones (or unknown).
/// Unknown on either side stops, so a device we cannot read errs toward silence.
/// Resume: stopped by an unplug, the same device is back, within `resume_min` minutes.
#[derive(Debug, PartialEq)]
enum Act { Stop, Resume(String), Nothing }
fn decide(prev: Option<bool>, new: Option<bool>, new_id: &str, playing: bool, unplugged: Option<&(String, u64, String)>, now: u64, resume_min: u64) -> Act {
    if playing {
        return if prev != Some(false) && new != Some(true) { Act::Stop } else { Act::Nothing }
    }
    match unplugged {
        Some((id, at, url)) if id == new_id && now.saturating_sub(*at) < resume_min * 60 && !url.is_empty() => Act::Resume(url.clone()),
        _ => Act::Nothing,
    }
}

fn device_changed(new_id: String) {
    let (hp, name) = headphones(&new_id);
    let prev = { let mut d = DEV.lock().unwrap(); d.replace(Dev { id: new_id.clone(), hp }) };
    let Some(prev) = prev else { return };
    if prev.id == new_id { return }
    let yn = |h: Option<bool>| match h { Some(true) => "headphones", Some(false) => "not headphones", None => "unknown" };
    let resume_min = radio_cfg()["resumeMin"].as_u64().unwrap_or(5);
    let (playing, unplugged, url) = { let r = R_.lock().unwrap(); (r.playing, r.unplugged.clone(), r.url.clone()) };
    let act = decide(prev.hp, hp, &new_id, playing, unplugged.as_ref(), now(), resume_min);
    log(&format!("radio: output changed ({} -> {}: {name}): {act:?}", yn(prev.hp), yn(hp)));
    match act {
        Act::Stop => { stop(); R_.lock().unwrap().unplugged = Some((prev.id, now(), url)); }
        Act::Resume(u) => { let _ = play_url(&u); }
        Act::Nothing => {}
    }
}

/// Starts watching the default output (once, with the player).
fn devices() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) { return }
    // The first look runs on its own thread: player() holds the radio's lock, and the device query waits.
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        let id = MediaDevice::GetDefaultAudioRenderId(AudioDeviceRole::Default).map(|i| i.to_string_lossy()).unwrap_or_default();
        let (hp, name) = headphones(&id);
        *DEV.lock().unwrap() = Some(Dev { id, hp });
        let reg = MediaDevice::DefaultAudioRenderDeviceChanged(|_, a| {
            let Some(a) = a.as_ref() else { return };
            if a.Role().ok() != Some(AudioDeviceRole::Default) { return }
            let id = a.Id().map(|i| i.to_string_lossy()).unwrap_or_default();
            std::thread::spawn(move || { let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) }; device_changed(id); });
        });
        match reg {
            Ok(r) => { r.forget(); log(&format!("radio: watching the audio output (now {name}, headphones: {hp:?})")); }
            Err(e) => log(&format!("radio: cannot watch the audio output: {e}")),
        }
    });
}

/// For a red alert: silence the radio now, and bring it back with `unmute`.
pub fn mute(why: &str, on: bool) {
    let mut r = R_.lock().unwrap();
    if let Some(p) = &r.player { let _ = p.SetIsMuted(on); }
    r.muted_for = if on { why.to_string() } else { String::new() };
}
pub fn is_playing() -> bool { R_.lock().unwrap().playing }

/// The sleep timer and the fade: checked every 5 seconds by a thread started on the first play.
fn clock() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) { return }
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        let mut n = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(5));
            n = n.wrapping_add(1);
            let (at, vol, playing) = { let r = R_.lock().unwrap(); (r.sleep_at, r.volume, r.playing) };
            // Candle lighting: checked every 20 seconds while it plays, with the board open or closed.
            if playing && n % 4 == 0 && blocked() { log("radio: stopped for shabbat or yom tov"); stop(); continue }
            if at == 0 || !playing { continue }
            let left = at as i64 - now() as i64;
            if left <= 0 { stop(); if let Ok(mut r) = R_.lock() { r.volume = vol; } after_sleep(); continue }
            // The last minute: fade out.
            if left < 60 { if let Some(p) = &R_.lock().unwrap().player { let _ = p.SetVolume(vol * left as f64 / 60.0); } }
        }
    });
}

/// The end of the sleep timer, by the user's choice (cards.radio.sleepEnd): "screen" turns the screen off,
/// "sleep" puts the computer to sleep; else only the stop.
fn after_sleep() {
    #[link(name = "user32")]
    unsafe extern "system" { fn PostMessageW(h: isize, msg: u32, w: usize, l: isize) -> i32; }
    #[link(name = "powrprof")]
    unsafe extern "system" { fn SetSuspendState(hibernate: u8, force: u8, wake_off: u8) -> u8; }
    match radio_cfg()["sleepEnd"].as_str().unwrap_or("") {
        // HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2 = off
        "screen" => { log("radio: sleep timer: screen off"); unsafe { PostMessageW(0xFFFF, 0x0112, 0xF170, 2); } }
        "sleep" => { log("radio: sleep timer: sleep"); unsafe { SetSuspendState(0, 0, 0); } }
        _ => {}
    }
}

/// The last station and the next/previous list, on disk: after a restart (sign-in, update) the widget still knows
/// them, and its "ניגון" plays the last station without the board.
fn keep_path() -> std::path::PathBuf { crate::data_dir().join("radio-last.json") }
fn keep() {
    let r = R_.lock().unwrap();
    let v = serde_json::json!({ "url": r.url, "name": r.name, "art": r.art, "list": r.list });
    drop(r);
    let _ = std::fs::write(keep_path(), v.to_string());
}
fn restore() {
    static DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if DONE.swap(true, std::sync::atomic::Ordering::Relaxed) { return }
    let Some(v) = std::fs::read(keep_path()).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) else { return };
    let mut r = R_.lock().unwrap();
    let g = |k: &str| v[k].as_str().unwrap_or("").to_string();
    if r.url.is_empty() { r.url = g("url"); r.name = g("name"); r.art = g("art"); }
    if r.list.is_empty() { r.list = serde_json::from_value(v["list"].clone()).unwrap_or_default(); }
}

/// The page's commands. Answers the state as JSON.
pub fn command(q: &str) -> String { command_with(q, "") }
/// The same, with a POST body as `d` (the page's lists).
pub fn command_with(q: &str, posted: &str) -> String {
    restore();
    let p = |k: &str| if k == "d" && !posted.is_empty() { posted.to_string() } else { crate::http::query(q, k).next().unwrap_or_default() };
    match p("do").as_str() {
        "play" => {
            { let mut r = R_.lock().unwrap(); r.name = p("name"); r.art = p("art"); r.title.clear(); }
            if let Err(e) = play_url(&p("url")) { log(&format!("radio: play: {e}")); }
            keep();
            clock();
        }
        "stop" => stop(),
        "alarms" => set_alarms(&p("d")),
        // The stations next/previous walk (favourites first), as [[url,name,art],...].
        "list" => {
            if let Ok(v) = serde_json::from_str::<Vec<(String, String, String)>>(&p("d")) { R_.lock().unwrap().list = v; keep(); }
        }
        "volume" => {
            let v: f64 = p("v").parse().unwrap_or(0.8);
            let mut r = R_.lock().unwrap();
            r.volume = v.clamp(0.0, 1.0);
            if let Some(pl) = &r.player { let _ = pl.SetVolume(r.volume); }
        }
        "sleep" => {
            let m: u64 = p("min").parse().unwrap_or(0);
            R_.lock().unwrap().sleep_at = if m == 0 { 0 } else { now() + m * 60 };
            clock();
        }
        "nowplaying" => {
            let mut r = R_.lock().unwrap();
            let t = p("title");
            if t != r.title { r.title = t; let _ = show(&r); }
        }
        _ => {}
    }
    let mut r = R_.lock().unwrap();
    let want = std::mem::take(&mut r.want);
    json!({ "playing": r.playing, "url": r.url, "name": r.name, "title": r.title, "volume": r.volume,
            "sleepLeft": if r.sleep_at > 0 { r.sleep_at.saturating_sub(now()) } else { 0 }, "want": want, "muted": r.muted_for, "quiet": r.refused }).to_string()
}

/// The red-alert sound, on its own player (the radio is muted meanwhile): "builtin" (Sounds\haluach-alert.wav),
/// "oref" (the official early-warning tone the user supplied), "windows" (the system alarm), "none".
/// `volume`: 0..1 from the user's setting (None = full).
/// Speaks a Hebrew text (Windows' Hebrew voice, "Microsoft Asaf", when installed), on its own alerts player.
pub fn speak(text: &str, volume: Option<f64>) { speak_boosted(text, volume, None) }

/// `boost`: Some(min 0..1) = the red alert's "even when the computer is muted" (sysvol), for ~30 s.
pub fn speak_boosted(text: &str, volume: Option<f64>, boost: Option<f32>) {
    let r = (|| -> windows_core::Result<()> {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        let synth = SpeechSynthesizer::new()?;
        let he = SpeechSynthesizer::AllVoices()?.into_iter().find(|v| v.Language().map(|l| l.to_string_lossy().starts_with("he")).unwrap_or(false));
        let Some(he) = he else { log("speak: no Hebrew voice on this computer"); return Ok(()) };
        synth.SetVoice(&he)?;
        let stream = synth.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.join()?;
        static P: Mutex<Option<MediaPlayer>> = Mutex::new(None);
        let mut g = P.lock().unwrap();
        let p = match &*g { Some(p) => p.clone(), None => { let p = MediaPlayer::new()?; p.SetAudioCategory(MediaPlayerAudioCategory::Alerts)?; *g = Some(p.clone()); p } };
        p.SetSource(&MediaSource::CreateFromStream(&stream, &stream.ContentType()?)?)?;
        p.SetVolume(volume.unwrap_or(1.0).clamp(0.0, 1.0))?;
        if let Some(r) = boost.and_then(crate::sysvol::boost) { r.after(30); }
        p.Play()
    })();
    if let Err(e) = r { log(&format!("speak: {e}")); }
}

pub fn alert_sound(which: &str, volume: Option<f64>) { alert_sound_boosted(which, volume, None) }

/// alert_sound, with the red alert's "even when the computer is muted" (sysvol) for ~30 s when `boost` is Some.
pub fn alert_sound_boosted(which: &str, volume: Option<f64>, boost: Option<f32>) {
    let file = match which { "none" => return, "oref" => "oref-early-warning.mp3", "windows" => "", _ => "haluach-alert.wav" };
    let r = (|| -> windows_core::Result<()> {
        static P: Mutex<Option<MediaPlayer>> = Mutex::new(None);
        let mut g = P.lock().unwrap();
        let p = match &*g { Some(p) => p.clone(), None => { let p = MediaPlayer::new()?; p.SetAudioCategory(MediaPlayerAudioCategory::Alerts)?; *g = Some(p.clone()); p } };
        let uri = if file.is_empty() { "ms-winsoundevent:Notification.Looping.Alarm".to_string() } else { format!("ms-appx:///Sounds/{file}") };
        p.SetSource(&MediaSource::CreateFromUri(&Uri::CreateUri(&HSTRING::from(uri))?)?)?;
        p.SetVolume(volume.unwrap_or(1.0).clamp(0.0, 1.0))?;
        if let Some(r) = boost.and_then(crate::sysvol::boost) { r.after(30); }
        p.Play()
    })();
    if let Err(e) = r { log(&format!("alert sound: {e}")); }
}

/// The widget's buttons: play the last station again, and next/previous in the page's list.
/// The stations the board sent (favourites first), as (url, name, art): the widget's "התאמה אישית" lists them.
pub fn stations() -> Vec<(String, String, String)> { restore(); R_.lock().unwrap().list.clone() }
/// One station by its address (a widget set to it): its name and picture from the list.
pub fn play_station(url: &str) {
    restore();
    let Some((u, name, art)) = R_.lock().unwrap().list.iter().find(|x| x.0 == url).cloned() else { return };
    { let mut r = R_.lock().unwrap(); r.name = name; r.art = art; r.title.clear(); }
    let _ = play_url(&u);
    keep();
    clock();
}
/// The address now playing ("" when stopped).
pub fn playing_url() -> String { let r = R_.lock().unwrap(); if r.playing { r.url.clone() } else { String::new() } }
pub fn resume() {
    restore();
    let url = R_.lock().unwrap().url.clone();
    let url = if url.is_empty() { R_.lock().unwrap().list.first().map(|x| x.0.clone()).unwrap_or_default() } else { url };
    if !url.is_empty() { let _ = play_url(&url); clock(); }
}
/// Next/previous from the media keys or the panel: the page hears it too (want), to follow.
fn key_step(fwd: bool) {
    R_.lock().unwrap().want = if fwd { "next".into() } else { "prev".into() };
    step(fwd);
}
pub fn step(fwd: bool) {
    restore();
    let mut r = R_.lock().unwrap();
    let n = r.list.len();
    if n == 0 { return }
    let at = r.list.iter().position(|x| x.0 == r.url).unwrap_or(0);
    let (url, name, art) = r.list[if fwd { (at + 1) % n } else { (at + n - 1) % n }].clone();
    r.name = name; r.art = art; r.title.clear();
    drop(r);
    let _ = play_url(&url);
    keep();
}

// ---------- the alarm ----------
// The page sends the next alarms: [{"id","at"(unix ms),"url","name","art","ramp"(secs)}]. This process plays them
// (it runs from sign-in: the StartupTask is on while alarms exist). To wake a sleeping computer, each alarm also
// gets a Task Scheduler task with WakeToRun one minute early (it only wakes the machine; it runs `cmd /c exit`).
// Nothing sounds on shabbat or yom tov (crate::quiet_now).
static ALARMS: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

fn wake_task(id: &str, at_ms: i64) -> String {
    use std::os::windows::process::CommandExt;
    // Local time for the task's StartBoundary.
    let t = at_ms / 1000 - 60;
    let st = {
        #[repr(C)] #[derive(Default)] struct S { y: u16, mo: u16, dw: u16, d: u16, h: u16, mi: u16, s: u16, ms: u16 }
        #[link(name = "kernel32")] unsafe extern "system" {
            fn FileTimeToSystemTime(ft: *const u64, st: *mut S) -> i32;
            fn SystemTimeToTzSpecificLocalTime(tz: *const core::ffi::c_void, u: *const S, l: *mut S) -> i32;
        }
        let ft = ((t + 11644473600) * 10_000_000) as u64;
        let (mut u, mut l) = (S::default(), S::default());
        unsafe { FileTimeToSystemTime(&ft, &mut u); SystemTimeToTzSpecificLocalTime(core::ptr::null(), &u, &mut l); }
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}", l.y, l.mo, l.d, l.h, l.mi, l.s)
    };
    let xml = format!(r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><TimeTrigger><StartBoundary>{st}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Settings><WakeToRun>true</WakeToRun><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT1M</ExecutionTimeLimit><Enabled>true</Enabled></Settings>
  <Actions><Exec><Command>cmd.exe</Command><Arguments>/c exit 0</Arguments></Exec></Actions>
</Task>"#);
    let path = std::env::temp_dir().join("haluach-wake.xml");
    let wide: Vec<u8> = std::iter::once(0xFEFFu16).chain(xml.encode_utf16()).flat_map(|c| c.to_le_bytes()).collect();
    if std::fs::write(&path, wide).is_err() { return String::new() }
    let name = format!("HaLuach\\Wake-{}", id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>());
    let ok = std::process::Command::new("schtasks").args(["/Create", "/TN", &name, "/XML", &path.display().to_string(), "/F"]).creation_flags(0x0800_0000).output().map(|o| o.status.success()).unwrap_or(false);
    if !ok { log(&format!("alarm: wake task {name} failed")); }
    name
}

pub fn set_alarms(d: &str) {
    let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(d) else { return };
    use std::os::windows::process::CommandExt;
    // Old wake tasks go (schtasks has no wildcard: the names are kept in a file); the new ones come.
    let list = crate::data_dir().join("wake-tasks.txt");
    for name in std::fs::read_to_string(&list).unwrap_or_default().lines().filter(|l| !l.is_empty()) {
        let _ = std::process::Command::new("schtasks").args(["/Delete", "/TN", name, "/F"]).creation_flags(0x0800_0000).output();
    }
    let mut made = vec![];
    for a in &v { if let (Some(id), Some(at)) = (a["id"].as_str(), a["at"].as_i64()) { made.push(wake_task(id, at)); } }
    let _ = std::fs::create_dir_all(crate::data_dir());
    let _ = std::fs::write(&list, made.join("\n"));
    *ALARMS.lock().unwrap() = v;
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) { return }
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            let now = now() as i64 * 1000;
            let due: Vec<serde_json::Value> = { let mut a = ALARMS.lock().unwrap(); let d = a.iter().filter(|x| x["at"].as_i64().is_some_and(|t| t <= now && now - t < 120_000)).cloned().collect(); a.retain(|x| x["at"].as_i64().is_some_and(|t| t > now)); d };
            for a in due {
                if crate::quiet_now(0) || blocked() { log("alarm: skipped (shabbat or yom tov)"); continue }
                let s = |k: &str| a[k].as_str().unwrap_or("").to_string();
                let target = R_.lock().unwrap().volume;
                { let mut r = R_.lock().unwrap(); r.name = s("name"); r.art = s("art"); r.title.clear(); r.volume = 0.05; }
                if play_url(&s("url")).is_err() { crate::radio::alert_sound("builtin", Some(target)); continue }
                // Rising volume over `ramp` seconds; a stream that fails falls back to the local sound (MediaFailed retries first).
                let ramp = a["ramp"].as_u64().unwrap_or(60).max(1);
                for i in 1..=ramp {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let v = target * i as f64 / ramp as f64;
                    let mut r = R_.lock().unwrap();
                    r.volume = v;
                    if let Some(p) = &r.player { let _ = p.SetVolume(v); }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: i64 = 3600 * 1000;

    #[test]
    fn quiet_windows() {
        let fri = 1_763_046_000_000; // a candle lighting
        let w = vec![(fri, fri + 25 * H)];
        assert!(!in_quiet(&w, fri - 1));
        assert!(in_quiet(&w, fri));
        assert!(in_quiet(&w, fri + 24 * H));
        assert!(!in_quiet(&w, fri + 25 * H));
        assert!(!in_quiet(&[], fri)); // no file
        assert!(!in_quiet(&[(fri - 50 * H, fri - 25 * H)], fri)); // stale
        assert!(!in_quiet(&[(fri + H, fri)], fri + H / 2)); // reversed
        assert!(!in_quiet(&[(fri - 10 * 24 * H, fri + 10 * 24 * H)], fri)); // broken: too long
        assert!(in_quiet(&[(fri - 50 * H, fri - 25 * H), (fri, fri + 74 * H)], fri + 70 * H)); // yom tov + shabbat
    }

    #[test]
    fn devices_decide() {
        let u = ("hp".to_string(), 1000u64, "https://x".to_string());
        assert_eq!(decide(Some(true), Some(false), "spk", true, None, 1000, 5), Act::Stop);
        assert_eq!(decide(Some(true), None, "spk", true, None, 1000, 5), Act::Stop);
        assert_eq!(decide(None, None, "spk", true, None, 1000, 5), Act::Stop);
        assert_eq!(decide(Some(false), Some(true), "hp", true, None, 1000, 5), Act::Nothing);
        assert_eq!(decide(Some(false), Some(false), "spk2", true, None, 1000, 5), Act::Nothing);
        assert_eq!(decide(Some(true), Some(true), "hp2", true, None, 1000, 5), Act::Nothing);
        assert_eq!(decide(Some(false), Some(true), "hp", false, Some(&u), 1000 + 299, 5), Act::Resume("https://x".into()));
        assert_eq!(decide(Some(false), Some(true), "hp", false, Some(&u), 1000 + 300, 5), Act::Nothing);
        assert_eq!(decide(Some(false), Some(true), "hp2", false, Some(&u), 1001, 5), Act::Nothing);
        assert_eq!(decide(Some(false), Some(true), "hp", false, None, 1001, 5), Act::Nothing);
    }

    /// The real default output and the event registration: cargo test -- --ignored --nocapture live_output
    #[test]
    #[ignore]
    fn live_output() {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        let id = MediaDevice::GetDefaultAudioRenderId(AudioDeviceRole::Default).unwrap().to_string_lossy();
        let (hp, name) = headphones(&id);
        println!("default output: {name}, headphones: {hp:?}");
        MediaDevice::DefaultAudioRenderDeviceChanged(|_, _| {}).unwrap().forget();
        println!("registered");
    }
}
