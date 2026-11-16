// Notifications for the page: a Windows toast and/or an announcement on the taskbar widgets button.
// The page decides what to show (its rules, its source adapters); this file only delivers.
use crate::bindings::*;
use windows_core::HSTRING;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A toast. Clicking it (or "פתיחה") opens `url` in the browser; `img` is a hero picture, `icon` the channel logo.
pub fn toast(title: &str, body: &str, url: &str, img: &str, icon: &str) -> windows_core::Result<()> {
    let https = |u: &str| u.starts_with("https://");
    let mut xml = format!(r#"<toast launch="{u}" activationType="protocol"><visual><binding template="ToastGeneric"><text hint-maxLines="2">{t}</text><text>{b}</text>"#,
        u = esc(url), t = esc(title), b = esc(body));
    if https(icon) { xml += &format!(r#"<image placement="appLogoOverride" hint-crop="circle" src="{}"/>"#, esc(icon)); }
    if https(img) { xml += &format!(r#"<image placement="hero" src="{}"/>"#, esc(img)); }
    xml += r#"</binding></visual>"#;
    if https(url) { xml += &format!(r#"<actions><action content="פתיחה" activationType="protocol" arguments="{}"/></actions>"#, esc(url)); }
    xml += "</toast>";
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    ToastNotificationManager::CreateToastNotifier()?.Show(&ToastNotification::CreateToastNotification(&doc)?)
}

/// The announcement on the widgets button (Windows shows it while the board is closed).
pub fn announce(id: &str, title: &str, body: &str) -> windows_core::Result<()> {
    let icon = Uri::CreateUri(&HSTRING::from("ms-appx:///Images/logo.png"))?;
    let a = FeedAnnouncement::CreateInstance(&HSTRING::from(id), &HSTRING::from(title), &HSTRING::from(body), &icon, &icon)?;
    a.SetShowBadgeIfUserNotEngaged(true)?;
    a.SetPrimaryTextColor(AnnouncementTextColor::Accent)?;
    // The test from Settings: shown for a few seconds and gone within a minute. Without this Windows keeps an
    // announcement on the button until the board is opened.
    // A real one goes away after 10 minutes if nobody opened the board.
    let ticks = |secs: u64| (secs * 10_000_000) as i64;   // 100 ns units
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if id.starts_with("test-") { a.SetDuration(windows_time::TimeSpan { duration: ticks(8) })?; }
    let keep = if id.starts_with("test-") { 60 } else { 600 };
    a.SetExpirationTime(windows_time::DateTime { universal_time: ticks(now + 11_644_473_600 + keep) })?;   // since 1601
    FeedManager::GetDefault()?.TryShowAnnouncement(&HSTRING::from("HaLuachFeed"), &HSTRING::from("haluach"), &a)
}

/// haluach-done:<prefix>,<prefix>: removes the scheduled reminders whose id starts with one of them ("קראתי ק״ש").
pub fn done(uri: &str) -> windows_core::Result<usize> {
    let list: Vec<&str> = uri.trim_matches('"').trim_start_matches("haluach-done:").split(',').filter(|p| p.len() > 2).collect();
    // Kept for 2 days, so the next plan from the page (every few hours) does not bring them back.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut kept: Vec<(String, i64)> = done_list().into_iter().filter(|(_, at)| now - at < 2 * 86_400_000).collect();
    kept.extend(list.iter().map(|p| (p.to_string(), now)));
    let _ = std::fs::write(crate::data_dir().join("done.json"), serde_json::to_string(&kept).unwrap_or_default());
    let notifier = ToastNotificationManager::CreateToastNotifier()?;
    let mut n = 0;
    for t in notifier.GetScheduledToastNotifications()? {
        let id = t.Id().map(|x| x.to_string_lossy()).unwrap_or_default();
        if list.iter().any(|p| id.starts_with(p)) { let _ = notifier.RemoveFromSchedule(&t); n += 1; }
    }
    Ok(n)
}

fn done_list() -> Vec<(String, i64)> { done_list_in(&crate::data_dir()) }
fn done_list_in(dir: &std::path::Path) -> Vec<(String, i64)> {
    std::fs::read(dir.join("done.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The page's planned notifications for the coming days (zmanim reminders, candles, omer, personal dates):
/// [{"id","at"(unix ms),"title","body","scenario"?}]. Windows keeps them and shows them on time with no process
/// running. The whole plan is replaced each time; nothing inside a shabbat/yom tov window is scheduled
/// (the user's rule: no notification at all on shabbat and yom tov; `quiet` = [[start ms, end ms], ...]).
pub fn schedule(plan: &serde_json::Value, quiet: &[(i64, i64)]) -> windows_core::Result<usize> {
    let notifier = ToastNotificationManager::CreateToastNotifier()?;
    for old in notifier.GetScheduledToastNotifications()? { let _ = notifier.RemoveFromSchedule(&old); }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut n = 0;
    let cancelled: Vec<String> = done_list().into_iter().filter(|(_, at)| now - at < 2 * 86_400_000).map(|(p, _)| p).collect();
    for it in plan.as_array().into_iter().flatten() {
        let at = it["at"].as_i64().unwrap_or(0);
        if at <= now + 5_000 || at > now + 16 * 86_400_000 { continue }
        if quiet.iter().any(|(a, b)| at >= *a && at < *b) { continue }
        let s = |k: &str| it[k].as_str().unwrap_or("").to_string();
        let scenario = if s("scenario") == "urgent" { r#" scenario="urgent""# } else { "" };
        // "קראתי" / "התפללתי": cancels the other reminders of this time today (done(), through the haluach-done: protocol).
        let done = match (it["done"]["label"].as_str(), it["done"]["ids"].as_array()) {
            (Some(l), Some(ids)) if !ids.is_empty() => {
                let ids: Vec<String> = ids.iter().filter_map(|x| x.as_str()).map(|x| x.chars().filter(|c| c.is_ascii_alphanumeric()).collect()).collect();
                format!(r#"<action content="{}" activationType="protocol" arguments="haluach-done:{}"/>"#, esc(l), ids.join(","))
            }
            _ => String::new(),
        };
        let xml = format!(r#"<toast{scenario}><visual><binding template="ToastGeneric"><text hint-maxLines="2">{}</text><text>{}</text></binding></visual><actions>{done}<action content="הזכר שוב" activationType="system" arguments="snooze"/><action content="סגירה" activationType="system" arguments="dismiss"/></actions></toast>"#, esc(&s("title")), esc(&s("body")));
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        // unix ms -> 100 ns ticks since 1601
        let when = windows_time::DateTime { universal_time: (at + 11_644_473_600_000) * 10_000 };
        let t = ScheduledToastNotification::CreateScheduledToastNotification(&doc, when)?;
        let id: String = s("id").chars().filter(|c| c.is_ascii_alphanumeric()).take(60).collect();
        if cancelled.iter().any(|p| id.starts_with(p.as_str())) { continue }
        if !id.is_empty() { let _ = t.SetId(&HSTRING::from(id)); }
        notifier.AddToSchedule(&t)?;
        n += 1;
    }
    // The page planned now: top_up_zmanim() waits until this plan is old.
    let _ = std::fs::write(crate::data_dir().join("plan-at.txt"), now.to_string());
    Ok(n)
}

// ---------- the zmanim reminders, kept planned with the board closed ----------
// The page plans 14 days (planner.js). If it is not opened for long, the plan runs out and the reminders stop.
// Once a day the provider checks: when the page's last plan (plan-at.txt) is older than 5 days, it ADDS the zmanim
// reminders for today+8 .. today+14 that are not scheduled yet. The same ids, texts and rules as planner.js.

/// web/src/cards/zmanim.js TIMES: id, name (the page's), default method, on by default (DEFAULT_ON).
const ZTIMES: [(&str, &str, &str, bool); 15] = [
    ("alot", "עלות השחר", "alot_90deg", true), ("misheyakir", "זמן ציצית ותפילין", "misheyakir_11_5", true), ("netz", "הנץ", "sunrise", true),
    ("shma_mga", "סוזק\"ש מג\"א", "shma_mga_chumra", true), ("shma_gra", "סוזק\"ש גר\"א", "shma_gra", true),
    ("tefila_mga", "סוזת\"פ מג\"א", "tefila_mga_chumra", false), ("tefila_gra", "סוזת\"פ גר\"א", "tefila_gra", true),
    ("chatzot", "חצות היום", "chatzot", true), ("mincha_gedola", "מנחה גדולה", "mincha_gedola_30", true),
    ("mincha_ketana", "מנחה קטנה", "mincha_ketana_gra", false), ("plag", "פלג המנחה", "plag_gra", true),
    ("shkia", "שקיעה", "sunset", true), ("tzeit", "צאת הכוכבים", "tzeit_6_45", true), ("rt", "רבנו תם", "rt_72deg", true),
    ("chatzot_night", "חצות הלילה", "chatzot_night", false)];

/// One planned reminder: (id as Windows keeps it, unix ms, title, body, done (label, ids), urgent).
type ZItem = (String, i64, String, String, Option<(String, Vec<String>)>, bool);

/// The id as schedule() keeps it: ascii letters and digits, at most 60.
fn alnum(s: &str) -> String { s.chars().filter(|c| c.is_ascii_alphanumeric()).take(60).collect() }

/// Local wall clock of unix ms: (days since 1970 of the local date, day of month, "HH:MM").
fn local_of(ms: i64) -> (i64, i64, String) {
    #[repr(C)]
    #[derive(Default)]
    struct St { y: u16, mo: u16, dw: u16, d: u16, h: u16, mi: u16, s: u16, ms: u16 }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn FileTimeToSystemTime(ft: *const u64, st: *mut St) -> i32;
        fn SystemTimeToTzSpecificLocalTime(tz: *const core::ffi::c_void, u: *const St, l: *mut St) -> i32;
    }
    let ft = ((ms / 1000 + 11644473600) * 10_000_000) as u64;
    let (mut u, mut l) = (St::default(), St::default());
    unsafe { FileTimeToSystemTime(&ft, &mut u); SystemTimeToTzSpecificLocalTime(core::ptr::null(), &u, &mut l); }
    (crate::zmanim::days_from_civil(l.y as i64, l.mo as i64, l.d as i64), l.d as i64, format!("{:02}:{:02}", l.h, l.mi))
}

fn truthy(v: &serde_json::Value) -> bool {
    use serde_json::Value::*;
    match v { Null => false, Bool(b) => *b, Number(n) => n.as_f64() != Some(0.0), String(s) => !s.is_empty(), _ => true }
}

/// zmanim.js remindersOf(s): [(timeId, [minutes before])], in the saved order.
fn reminders_of(st: &serde_json::Value) -> Vec<(String, Vec<i64>)> {
    let z = &st["cards"]["zmanim"];
    // JS `if (s.remind)`: any object (an empty one too) is the user's choice.
    if let Some(r) = z["remind"].as_object() {
        return r.iter().map(|(k, v)| (k.clone(), v.as_array().into_iter().flatten().filter_map(|m| m.as_f64().map(|x| x as i64)).collect())).collect();
    }
    if !truthy(&st["notify"]["zmanim"]) { return vec![] }
    ZTIMES.iter().filter(|(id, _, _, on)| z["on"][*id].as_bool().unwrap_or(*on) && (id.starts_with("shma_") || id.starts_with("tefila_")))
        .map(|(id, ..)| (id.to_string(), vec![15])).collect()
}

/// planner.js's zmanim source for the local days today+from .. today+to (both in), the past ones left out.
fn zmanim_plan(st: &serde_json::Value, now: i64, from: i64, to: i64) -> Vec<ZItem> {
    let want = reminders_of(st);
    if want.iter().all(|(_, m)| m.is_empty()) { return vec![] }
    let num = |k: &str| st[k].as_f64().or_else(|| st["loc"][k].as_f64());
    let (Some(lat), Some(lng)) = (num("lat"), num("lng")) else { return vec![] };
    let elev = num("elev").unwrap_or(0.0);
    let z = &st["cards"]["zmanim"];
    let urgent_on = st["notify"]["zmanimUrgent"].as_bool().unwrap_or(false);
    let urgent_off: Vec<&str> = st["notify"]["zmanimUrgentOff"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
    let secs = crate::widgets::zman_secs(st);
    let today = local_of(now).0;
    let mut out = vec![];
    for d in from..=to {
        let day = today + d;
        let mut t = crate::zmanim::compute(day, lat, lng, elev).t;
        // The visible sunrise / sunset, when the horizon profile is on disk already (as widgets.rs day_times).
        let skip = z["visKm"].as_f64().unwrap_or(2.0);
        for (k, rising) in [("sunrise_vis", true), ("sunset_vis", false)] {
            if crate::horizon::ready(lat, lng, rising) {
                if let Some(v) = crate::horizon::visible(day, lat, lng, rising, skip) { t.insert(k.into(), serde_json::json!((v * 1000.0).round() as i64)); }
            }
        }
        let dd = crate::zmanim::civil_from_days(day).2;
        for (id, mins) in &want {
            let Some((_, name, def, _)) = ZTIMES.iter().find(|x| x.0 == id) else { continue };
            let method = z["method"][id.as_str()].as_str().unwrap_or(def);
            let Some(at) = t.get(method).and_then(|v| v.as_i64()) else { continue };
            // "קראתי" / "התפללתי" cancels the rest of the day's reminders of shema (both opinions), or of tefila.
            let kind = if id.starts_with("shma") { "shma" } else if id.starts_with("tefila") { "tefila" } else { "" };
            let done = (!kind.is_empty()).then(|| (if kind == "shma" { "קראתי" } else { "התפללתי" }.to_string(),
                want.iter().filter(|(k, _)| k.starts_with(kind)).map(|(k, _)| alnum(&format!("z{k}{dd}m"))).collect::<Vec<_>>()));
            let min = mins.iter().copied().min().unwrap_or(0);
            // The time itself rounded l'chumra, as the card shows it (widgets::zman_time).
            let body = crate::widgets::zman_time(id, at, secs);
            for m in mins {
                let when = at - m * 60_000;
                if when <= now + 5_000 { continue }
                out.push((alnum(&format!("z{id}{dd}m{m}")), when, format!("{name} בעוד {m} דקות"), body.clone(), done.clone(), urgent_on && !urgent_off.contains(&id.as_str()) && *m == min));
            }
        }
    }
    out
}

/// What top_up_zmanim() adds now: the plan for today+8 .. today+14 less the quiet windows, the cancelled ids
/// and the ids in `have`. Beyond quiet.json's range: the computed Shabbat is left out (yom tov is not known there).
fn top_up_items(dir: &std::path::Path, have: &[String], now: i64) -> Vec<ZItem> {
    let st = crate::widgets::settings_value();
    let quiet: Vec<(i64, i64)> = std::fs::read(dir.join("quiet.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let known_to = quiet.iter().map(|w| w.1).max().unwrap_or(0);
    let cancelled: Vec<String> = done_list_in(dir).into_iter().filter(|(_, at)| now - at < 2 * 86_400_000).map(|(p, _)| p).collect();
    zmanim_plan(&st, now, 8, 14).into_iter().filter(|it| {
        let at = it.1;
        if quiet.iter().any(|(a, b)| at >= *a && at < *b) { return false }
        // Beyond quiet.json: the computed Shabbat (Friday sunset - 40 min to Saturday nightfall; no yom tov, see crate::shabbat_at).
        if at >= known_to && crate::shabbat_at(at).is_some_and(|(a, b)| at >= a && at < b) { return false }
        !have.iter().any(|h| *h == it.0) && !cancelled.iter().any(|p| it.0.starts_with(p.as_str()))
    }).collect()
}

/// How old the page's last plan is (plan-at.txt). No record (none yet, or from before this version): very old.
fn plan_age_ms(dir: &std::path::Path, now: i64) -> i64 {
    std::fs::read_to_string(dir.join("plan-at.txt")).ok().and_then(|s| s.trim().parse::<i64>().ok()).map(|t| now - t).unwrap_or(i64::MAX)
}

/// Once a day (bg.rs): keeps the zmanim reminders planned when the page has not planned for over 5 days.
/// Adds only; what is scheduled stays. Returns how many were added.
pub fn top_up_zmanim() -> windows_core::Result<usize> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let dir = crate::data_dir();
    if plan_age_ms(&dir, now) < 5 * 86_400_000 { return Ok(0) }
    let notifier = ToastNotificationManager::CreateToastNotifier()?;
    let have: Vec<String> = notifier.GetScheduledToastNotifications()?.into_iter().map(|t| t.Id().map(|x| x.to_string_lossy()).unwrap_or_default()).collect();
    let mut n = 0;
    for (id, at, title, body, done, urgent) in top_up_items(&dir, &have, now) {
        let scenario = if urgent { r#" scenario="urgent""# } else { "" };
        let done = done.map(|(l, ids)| format!(r#"<action content="{}" activationType="protocol" arguments="haluach-done:{}"/>"#, esc(&l), ids.join(","))).unwrap_or_default();
        let xml = format!(r#"<toast{scenario}><visual><binding template="ToastGeneric"><text hint-maxLines="2">{}</text><text>{}</text></binding></visual><actions>{done}<action content="הזכר שוב" activationType="system" arguments="snooze"/><action content="סגירה" activationType="system" arguments="dismiss"/></actions></toast>"#, esc(&title), esc(&body));
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let when = windows_time::DateTime { universal_time: (at + 11_644_473_600_000) * 10_000 };
        let t = ScheduledToastNotification::CreateScheduledToastNotification(&doc, when)?;
        let _ = t.SetId(&HSTRING::from(id));
        notifier.AddToSchedule(&t)?;
        n += 1;
    }
    Ok(n)
}

/// Dev aid (--plan-once <data folder>): prints what top_up_zmanim() would add, as if nothing were scheduled
/// and whatever the plan's age. Nothing is scheduled.
pub fn plan_once(folder: Option<&str>) {
    let dir = folder.map(std::path::PathBuf::from).unwrap_or_else(crate::data_dir);
    crate::widgets::set_dir(&dir.to_string_lossy());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let age = plan_age_ms(&dir, now);
    let items: Vec<serde_json::Value> = top_up_items(&dir, &[], now).into_iter().map(|(id, at, title, body, done, urgent)| {
        let (day, _, hm) = local_of(at);
        let (y, m, d) = crate::zmanim::civil_from_days(day);
        serde_json::json!({ "id": id, "at": format!("{y}-{m:02}-{d:02} {hm}"), "title": title, "body": body,
            "done": done.map(|(l, ids)| serde_json::json!({ "label": l, "ids": ids })), "urgent": urgent })
    }).collect();
    let days = if age == i64::MAX { serde_json::Value::Null } else { serde_json::json!(age / 86_400_000) };
    let out = serde_json::json!({ "planAgeDays": days, "wouldRun": age >= 5 * 86_400_000, "add": items });
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
}

/// A red-alert toast: "urgent" breaks through Focus (when the user allows it), with the Windows alarm sound off
/// (our own sound plays: radio::alert_sound), and stays until dismissed.
pub fn urgent(title: &str, body: &str, break_focus: bool) -> windows_core::Result<()> {
    let scenario = if break_focus { r#" scenario="urgent""# } else { r#" scenario="reminder""# };
    let xml = format!(r#"<toast{scenario}><visual><binding template="ToastGeneric"><text hint-maxLines="2">{}</text><text>{}</text></binding></visual><audio silent="true"/><actions><action content="סגירה" activationType="system" arguments="dismiss"/></actions></toast>"#, esc(title), esc(body));
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    ToastNotificationManager::CreateToastNotifier()?.Show(&ToastNotification::CreateToastNotification(&doc)?)
}

// ---------- sent alerts (data_dir()/alerts-sent.json: [[id, unix ms]], 3 days) ----------
// One store for the page (/board/notify) and the background checks (bg.rs), so an alert goes out once.
static SENT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
const SENT_KEEP_MS: i64 = 3 * 86_400_000;

fn sent_list() -> Vec<(String, i64)> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let all: Vec<(String, i64)> = std::fs::read(crate::data_dir().join("alerts-sent.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    all.into_iter().filter(|(_, at)| now - at < SENT_KEEP_MS).collect()
}

/// Was this notification id sent in the last 3 days?
pub fn seen(id: &str) -> bool {
    let _g = SENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    sent_list().iter().any(|(x, _)| x == id)
}

/// Records an id as sent (and drops the ones older than 3 days).
pub fn mark(id: &str) {
    let _g = SENT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut list = sent_list();
    if list.iter().any(|(x, _)| x == id) { return }
    list.push((id.to_string(), now));
    let _ = std::fs::create_dir_all(crate::data_dir());
    let _ = std::fs::write(crate::data_dir().join("alerts-sent.json"), serde_json::to_string(&list).unwrap_or_default());
}
