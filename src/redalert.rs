// "צבע אדום": Pikud HaOref's live alerts, polled every 2 seconds by the provider (so it works with the board closed;
// the StartupTask starts the process at sign-in when the user turns this on). Pikud HaOref answers only
// Israeli addresses (research/sources.md); otherwise Tzofar's public API is the source (tzofar()).
// The user's rules (SPEC): which towns to show and sound (or all of Israel); a separate switch for the non-war
// types (earthquake, tsunami, hazardous materials): everywhere or only the chosen towns; after X time with no alert
// anywhere, the next one shows from everywhere. A sound per type. The radio is muted during an alert.
// On shabbat and yom tov nothing goes out (the user: "אף אחד לא צריך אותי בשביל צבע אדום").
use crate::{log, notify};
use serde_json::{json, Value};
use std::sync::Mutex;

// The address the old one redirects to (checked from the Pi 15.11.26).
const URL: &str = "https://www.oref.org.il/warningMessages/alert/Alerts.json";
const HEADERS: &str = "Referer: https://www.oref.org.il/\r\nX-Requested-With: XMLHttpRequest\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n";

struct St {
    last_id: String,
    last_any: u64,        // unix secs of the last alert anywhere
    current: Value,       // the alert now (or Null)
    history: Vec<Value>,  // today's, newest first
    reachable: Option<bool>,
    recent: Vec<(u64, bool, &'static str, Vec<String>)>, // (unix secs, from Tzofar, kind, sorted towns) handled lately
}
static ST: Mutex<St> = Mutex::new(St { last_id: String::new(), last_any: 0, current: Value::Null, history: Vec::new(), reachable: None, recent: Vec::new() });
/// The same alert from the OTHER source (Tzofar's id differs from Pikud HaOref's) within this span is not sent again.
/// Only across sources: a new salvo from the same source on the same towns is a real new alert.
const DUP_SECS: u64 = 180;

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
fn cfg() -> Value {
    let s: Value = std::fs::read(crate::data_dir().join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    s["cards"]["redalert"].clone()
}

/// The alert's type, from its title (the numeric categories are not documented; the titles are stable Hebrew).
pub fn kind(title: &str) -> &'static str {
    if title.contains("רעידת") { "quake" }
    else if title.contains("צונאמי") { "tsunami" }
    else if title.contains("חומרים מסוכנים") { "hazmat" }
    else if title.contains("כלי טיס") { "aircraft" }
    else if title.contains("האירוע הסתיים") { "end" }
    else if title.contains("בדקות הקרובות") || title.contains("התרעה מוקדמת") || title.contains("עדכון") { "early" }
    else { "missiles" }
}
fn non_war(k: &str) -> bool { matches!(k, "quake" | "tsunami" | "hazmat") }

/// Which of the alert's towns this user wants (empty = none).
fn wanted(c: &Value, k: &str, towns: &[String], rare: bool) -> Vec<String> {
    let all = c["all"].as_bool().unwrap_or(false) || rare || (non_war(k) && c["nonWarAll"].as_bool().unwrap_or(true));
    let chosen: Vec<String> = c["towns"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
    towns.iter().filter(|t| all || chosen.iter().any(|c| t.starts_with(c.as_str()) || c.starts_with(t.as_str()))).cloned().collect()
}

fn poll_once() {
    let c = cfg();
    if !c["enabled"].as_bool().unwrap_or(false) { return }
    let r = crate::http::fetch("GET", URL, HEADERS, b"");
    let ok = r.as_ref().is_some_and(|r| r.status == 200);
    // Abroad (Pikud HaOref answers only Israeli addresses): Tzofar's public API instead.
    if !ok { let tz = tzofar(&c); ST.lock().unwrap().reachable = Some(tz); return }
    ST.lock().unwrap().reachable = Some(true);
    let r = r.unwrap();
    let body = String::from_utf8_lossy(&r.body);
    let body = body.trim_start_matches('\u{FEFF}').trim();
    if body.is_empty() { ST.lock().unwrap().current = Value::Null; return }
    let Ok(a) = serde_json::from_str::<Value>(body) else { return };
    handle(&c, &a);
}

// ---------- the second source: Tzofar's public API (open in NetFree, checked from the Pi 15.11.26) ----------
// Used when Pikud HaOref does not answer (it answers only Israeli addresses). /notifications is "[]" when there is
// nothing, else [{notificationId, time, threat, isDrill, cities}]. The threat numbers (Tzofar's own, the same in
// /alerts-history): 0 rockets, 1 hazardous materials, 2 infiltration, 3 earthquake, 4 tsunami, 5 hostile aircraft,
// 6 radiological, 7 non-conventional, 8 a general alert, 9 a drill. Never a source that NetFree blocks (the user).
const TZOFAR: &str = "https://api.tzevaadom.co.il/notifications";
static TZ_SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn threat_title(n: i64) -> &'static str {
    match n {
        1 => "חומרים מסוכנים", 2 => "חדירת מחבלים", 3 => "רעידת אדמה", 4 => "צונאמי", 5 => "חדירת כלי טיס עוין",
        6 => "אירוע רדיולוגי", 7 => "ירי בלתי קונבנציונלי", 8 => "התרעה", _ => "ירי רקטות וטילים",
    }
}
fn tzofar(c: &Value) -> bool {
    let Some(r) = crate::http::fetch("GET", TZOFAR, "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n", b"").filter(|r| r.status == 200) else { return false };
    let Ok(list) = serde_json::from_slice::<Vec<Value>>(&r.body) else { return false };
    // Nothing now: the alert is over on the card (as Pikud HaOref's empty answer).
    if list.is_empty() { ST.lock().unwrap().current = Value::Null; return true }
    for n in list {
        if n["isDrill"].as_bool().unwrap_or(false) || n["threat"].as_i64() == Some(9) { continue }
        let id = n["notificationId"].as_str().map(str::to_string).unwrap_or_else(|| format!("{}-{}", n["time"], n["threat"]));
        {
            let mut seen = TZ_SEEN.lock().unwrap();
            if seen.contains(&id) { continue }
            seen.push(id.clone());
            if seen.len() > 200 { seen.remove(0); }
        }
        let a = json!({ "id": format!("tz{id}"), "title": threat_title(n["threat"].as_i64().unwrap_or(0)), "data": n["cities"], "desc": "" });
        handle(c, &a);
    }
    true
}

/// One alert (Pikud HaOref's JSON, or Tzofar's made into it): the user's rules, the toast, the sound.
fn handle(c: &Value, a: &Value) {
    let c = c.clone();
    let id = a["id"].as_str().unwrap_or("").to_string();
    let title = a["title"].as_str().unwrap_or("").to_string();
    let towns: Vec<String> = a["data"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
    let k = kind(&title);
    let mut st = ST.lock().unwrap();
    if id == st.last_id { return }
    st.last_id = id.clone();
    // The same alert from the other source (Pikud HaOref failed briefly, Tzofar has it with its own id):
    // the same kind and towns (or a part of them) within DUP_SECS from the other source -> no second toast and sound.
    // From the same source only last_id counts (a new salvo on the same towns must sound).
    let mut sorted = towns.clone();
    sorted.sort();
    sorted.dedup();
    let t = now();
    let tz = id.starts_with("tz");
    st.recent.retain(|(at, _, _, _)| t.saturating_sub(*at) < DUP_SECS);
    if st.recent.iter().any(|(_, rtz, rk, rt)| *rtz != tz && *rk == k && sorted.iter().all(|x| rt.binary_search(x).is_ok())) {
        log(&format!("redalert: duplicate {k} ({id}) skipped"));
        return
    }
    st.recent.push((t, tz, k, sorted));
    // "Rare": no alert anywhere for longer than the user's span -> this one shows from everywhere.
    // On disk too, so a restart (sign-in, update) does not forget how long it was quiet.
    let file = crate::data_dir().join("redalert-last.txt");
    if st.last_any == 0 { st.last_any = std::fs::read_to_string(&file).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0); }
    let rare_secs = c["rareSecs"].as_u64().unwrap_or(0);
    let rare = rare_secs > 0 && st.last_any > 0 && now() - st.last_any > rare_secs;
    st.last_any = now();
    let _ = std::fs::write(&file, st.last_any.to_string());
    let mine = wanted(&c, k, &towns, rare);
    let shelter = shelter_secs(&mine);
    let item = json!({ "id": id, "title": title, "kind": k, "towns": towns, "mine": mine, "desc": a["desc"], "at": now() * 1000, "shelter": shelter });
    st.history.insert(0, item.clone());
    st.history.truncate(200);
    st.current = item;
    drop(st);
    if mine.is_empty() || crate::quiet_now(0) { return }
    log(&format!("redalert: {k} {} towns", mine.len()));
    let shown: Vec<&str> = mine.iter().take(8).map(String::as_str).collect();
    let more = if mine.len() > 8 { format!(" ועוד {}", mine.len() - 8) } else { String::new() };
    if c["toast"].as_bool().unwrap_or(true) {
        let time = shelter.map(|t| format!("
זמן להגיע למרחב מוגן: {}", shelter_text(t))).unwrap_or_default();
        let _ = notify::urgent(&title, &format!("{}{more}{time}", shown.join(", ")), c["breakFocus"].as_bool().unwrap_or(true));
    }
    if k == "end" { crate::radio::mute("alert", false); return }
    if c["muteRadio"].as_bool().unwrap_or(true) && crate::radio::is_playing() {
        crate::radio::mute("alert", true);
        // Unmute after 10 minutes if no "event ended" message came.
        std::thread::spawn(|| { std::thread::sleep(std::time::Duration::from_secs(600)); crate::radio::mute("alert", false); });
    }
    let sound = c["sound"][k].as_str().or(c["sound"]["default"].as_str()).unwrap_or("builtin").to_string();
    // "גם כשהמחשב מושתק" (cards.redalert.unmute): unmute and raise the output to minVol% for the alert only.
    let boost = c["unmute"].as_bool().unwrap_or(false).then(|| (c["minVol"].as_f64().unwrap_or(60.0) / 100.0) as f32);
    crate::radio::alert_sound_boosted(&sound, c["volume"].as_f64(), boost);
    // Read aloud (cards.redalert.speak): the kind, up to 5 towns and the time to shelter, after the sound starts.
    if c["speak"].as_bool().unwrap_or(false) {
        let towns = if mine.len() > 5 { format!("{} ועוד {}", mine[..5].join(", "), mine.len() - 5) } else { mine.join(", ") };
        let time = shelter.map(|t| format!(". זמן להגיע למרחב מוגן: {}", shelter_text(t))).unwrap_or_default();
        let text = format!("{title}. {towns}{time}");
        let vol = c["volume"].as_f64();
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(3)); crate::radio::speak_boosted(&text, vol, boost); });
    }
}

/// The seconds to reach a protected space per town (Tzofar's public list, "countdown"), kept in data_dir for a week.
fn shelter_map() -> std::collections::HashMap<String, u64> {
    static MAP: Mutex<Option<(u64, std::collections::HashMap<String, u64>)>> = Mutex::new(None);
    let mut g = MAP.lock().unwrap();
    if let Some((t, m)) = g.as_ref() { if now() - t < 7 * 86400 && !m.is_empty() { return m.clone() } }
    let path = crate::data_dir().join("shelter.json");
    let parse = |b: &[u8]| -> std::collections::HashMap<String, u64> {
        let v: Value = serde_json::from_slice(b).unwrap_or(json!({}));
        let cities = if v["cities"].is_object() { &v["cities"] } else { &v };
        cities.as_object().into_iter().flatten().filter_map(|(_, x)| Some((x["he"].as_str()?.to_string(), x["countdown"].as_u64()?))).collect()
    };
    let fresh = std::fs::metadata(&path).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|e| e.as_secs() < 7 * 86400);
    let mut m = if fresh { std::fs::read(&path).map(|b| parse(&b)).unwrap_or_default() } else { Default::default() };
    if m.is_empty() {
        if let Some(r) = crate::http::fetch("GET", "https://www.tzevaadom.co.il/static/cities.json", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n", b"") {
            if r.status == 200 { m = parse(&r.body); if !m.is_empty() { let _ = std::fs::write(&path, &r.body); } }
        }
    }
    // Not reachable (abroad, or blocked): the copy in the package (research/towns-shelter.json, {town: seconds}).
    if m.is_empty() {
        let v: Value = serde_json::from_str(include_str!("../research/towns-shelter.json")).unwrap_or(json!({}));
        m = v.as_object().into_iter().flatten().filter_map(|(k, x)| Some((k.clone(), x.as_u64()?))).collect();
    }
    *g = Some((now(), m.clone()));
    m
}
/// The shortest time to a protected space among these towns.
fn shelter_secs(towns: &[String]) -> Option<u64> {
    if towns.is_empty() { return None }
    let m = shelter_map();
    towns.iter().filter_map(|t| m.get(t).copied()).min()
}
pub fn shelter_text(s: u64) -> String {
    match s { 0 => "מיד".into(), 1..=59 => format!("{s} שניות"), 60 => "דקה".into(), 90 => "דקה וחצי".into(), _ => format!("{} דקות", (s + 30) / 60) }
}

/// Starts the poller once (from main: the board, the widgets or the StartupTask brought the process up).
pub fn start() {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) { return }
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        loop {
            poll_once();
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

/// For the card: {reachable, current, history}.
pub fn state() -> String {
    let st = ST.lock().unwrap();
    json!({ "reachable": st.reachable, "current": st.current, "history": st.history, "lastAny": st.last_any * 1000 }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kinds() {
        assert_eq!(kind("ירי רקטות וטילים"), "missiles");
        assert_eq!(kind("חדירת כלי טיס עוין"), "aircraft");
        assert_eq!(kind("רעידת אדמה"), "quake");
        assert_eq!(kind("האירוע הסתיים"), "end");
    }
    #[test]
    fn filter() {
        let c = json!({ "towns": ["בני ברק"], "nonWarAll": true });
        let t = vec!["בני ברק".to_string(), "רמת גן - מזרח".to_string()];
        assert_eq!(wanted(&c, "missiles", &t, false), vec!["בני ברק".to_string()]);
        assert_eq!(wanted(&c, "quake", &t, false).len(), 2);
        assert_eq!(wanted(&c, "missiles", &t, true).len(), 2);
        assert!(wanted(&json!({ "towns": ["אילת"] }), "missiles", &t, false).is_empty());
    }
}
