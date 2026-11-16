// The widgets (Windows App SDK widget provider). Cards are Adaptive Cards, right to left.
// Three kinds of content:
//  - computed here, so they work with the board closed: "zmanim" (zmanim.rs), "redalert" (redalert.rs), "radio" (radio.rs, with buttons);
//  - pushed by the board page (/board/widgets?d=) or by forums.rs: every other card's summary
//    { big, sub, rows: [[label, value, strong?, url?]] }, kept on disk so a widget shows something after a restart too.
// Microsoft's widget rules (learn.microsoft.com, widgets design fundamentals and interaction design), as in HaFeed:
// no title inside the card (the board draws it), at most 1 / 3 / 4 click targets for small / medium / large,
// the Windows type ramp, spacing in multiples of 4, text buttons (no emoji or glyphs as labels), and a tap on the
// widget opens the provider's full experience: here the board's HaLuach page, at that card.
use crate::bindings::*;
use crate::{log, zmanim};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use windows_core::{implement, Ref, HSTRING};

pub struct W {
    kind: String,
    size: WidgetSize,
    active: bool,
    /// The widget's own choice (its CustomState): for "transit", one stop's code; empty = the board's settings.
    custom: String,
    /// The customization form is showing (the user picked "התאמה אישית" in the widget's menu).
    editing: bool,
    /// Zmanim's customization: the places the last search found [(name, lat, lng)].
    found: Vec<(String, f64, f64, f64)>,
}
static WIDGETS: Mutex<BTreeMap<String, W>> = Mutex::new(BTreeMap::new());
static DATA: Mutex<Option<Value>> = Mutex::new(None);
/// The card a widget tap asked for; the page takes it (GET /board/widgets) when it shows and opens that card.
static GOTO: Mutex<String> = Mutex::new(String::new());
/// Dev aid: read the data from another folder (the packaged app's LocalCache) instead of data_dir().
static DIR: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn dir() -> std::path::PathBuf { DIR.lock().unwrap().clone().unwrap_or_else(crate::data_dir) }
fn settings() -> Value {
    std::fs::read(dir().join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}))
}
fn data_path() -> std::path::PathBuf { dir().join("widgets.json") }
fn load() -> Value { std::fs::read(data_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({})) }
fn data() -> Value {
    let mut g = DATA.lock().unwrap();
    g.get_or_insert_with(load).clone()
}
/// One read-modify-write of the summaries under the DATA lock (threads push at once: forums, buses, shipments, bg,
/// the page), written through a temp file and a rename. The lock is free again before the cards re-render
/// (update_all reads data()).
fn change(f: impl FnOnce(&mut Value)) {
    {
        let mut g = DATA.lock().unwrap();
        let all = g.get_or_insert_with(load);
        f(all);
        let _ = std::fs::create_dir_all(dir());
        let (path, tmp) = (data_path(), dir().join("widgets.json.tmp"));
        if std::fs::write(&tmp, all.to_string()).is_ok() && std::fs::rename(&tmp, &path).is_err() { let _ = std::fs::remove_file(&tmp); }
    }
    update_all();
}
/// The page's summaries: {cardId: {big, sub, rows, at}}. An empty body only asks for the pending tap.
pub fn push(body: &str) {
    if body.is_empty() { return }
    let Ok(new) = serde_json::from_str::<Value>(body) else { return log("widgets: bad push") };
    let Some(n) = new.as_object() else { return log("widgets: bad push") };
    change(|all| {
        if !all.is_object() { *all = json!({}); }
        let Some(a) = all.as_object_mut() else { return };
        for (k, v) in n {
            // The newer summary wins: the page re-sends its older ones, and bg.rs writes between the page's pushes.
            if let (Some(had), Some(got)) = (a.get(k).and_then(|x| x["at"].as_i64()), v["at"].as_i64()) { if had > got { continue } }
            let mut v = v.clone();
            // A summary without "per" keeps the one set_per wrote (weather for another place); one with "per"
            // (the page's own, for rates/learning/transit/forums) replaces it.
            if v.is_object() && v.get("per").is_none() {
                if let Some(per) = a.get(k).and_then(|x| x.get("per")).filter(|p| p.is_object()) { v["per"] = per.clone(); }
            }
            a.insert(k.clone(), v);
        }
    });
}
/// The summaries on disk now ({cardId: {.., at}}), for bg.rs.
pub fn current() -> Value { data() }
/// The page's settings.json, for bg.rs.
pub fn settings_value() -> Value { settings() }
/// Is a widget of this kind pinned (bg.rs refreshes only those)?
pub fn has_kind(kind: &str) -> bool { WIDGETS.lock().unwrap().values().any(|w| w.kind == kind) }
/// Is a widget of this kind on the board now (shown)? buses.rs fetches only then.
pub fn has_active(kind: &str) -> bool { WIDGETS.lock().unwrap().values().any(|w| w.kind == kind && w.active) }
/// The own places of the pinned widgets of a kind (their CustomState), for bg.rs.
pub fn customs(kind: &str) -> Vec<String> {
    let mut v: Vec<String> = WIDGETS.lock().unwrap().values().filter(|w| w.kind == kind && !w.custom.is_empty()).map(|w| w.custom.clone()).collect();
    v.sort(); v.dedup(); v
}
/// A summary for one widget's own choice: data[kind].per[key] (bg.rs, weather for another place).
pub fn set_per(kind: &str, key: &str, v: Value) {
    change(|all| {
        if !all.is_object() { *all = json!({}); }
        if !all[kind].is_object() { all[kind] = json!({}); }
        if !all[kind]["per"].is_object() { all[kind]["per"] = json!({}); }
        all[kind]["per"][key] = v;
    });
}
/// Dev aid: read the data from another folder (as dump()).
pub fn set_dir(folder: &str) { *DIR.lock().unwrap() = Some(folder.into()); }
/// The card id of the last widget tap, once (empty when there was none). The answer of /board/widgets.
pub fn take_goto() -> String { std::mem::take(&mut *GOTO.lock().unwrap()) }
/// The page saved new settings: every card may change.
pub fn settings_changed() { update_all(); }

// ---------- building blocks ----------
/// A date-bound summary sent ahead (core.js ahead()): the latest entry that has started, else the summary itself.
fn now_of(x: &Value) -> Value {
    let now = now_ms();
    let picked = x["ahead"].as_array().and_then(|a| a.iter().filter(|e| e["from"].as_i64().is_some_and(|f| f <= now)).last());
    match picked { Some(e) => { let mut e = e.clone(); e["at"] = json!(now); e } None => x.clone() }
}
/// The whole widget is one click target: it opens the board at this card.
fn open_board(kind: &str) -> Value { json!({ "type": "Action.Execute", "verb": "open", "data": { "card": kind } }) }
fn card(kind: &str, body: Value, actions: Value) -> String {
    let mut c = card_only(body, actions);
    c["selectAction"] = open_board(kind);
    c.to_string()
}
/// A card the widget itself does not open (a small one whose single target is a button).
fn card_only(body: Value, actions: Value) -> Value {
    json!({ "type": "AdaptiveCard", "version": "1.5", "body": body, "actions": actions, "$schema": "http://adaptivecards.io/schemas/adaptive-card.json" })
}
fn text(t: &str, extra: Value) -> Value {
    let mut b = json!({ "type": "TextBlock", "text": t, "wrap": true });
    if let (Some(o), Some(e)) = (b.as_object_mut(), extra.as_object()) { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
    b
}
/// A message alone in the widget: centred, a little down (as HaFeed's empty widgets).
fn note(t: &str) -> Value { json!([text(t, json!({ "isSubtle": true, "horizontalAlignment": "Center", "spacing": "Large" }))]) }
fn s(v: &Value) -> &str { v.as_str().unwrap_or("") }
const OPEN_BOARD: &str = "פתחו את הלוח פעם אחת, וכאן יופיע המידע. אחר כך הוא מתעדכן לבד.";

// Heights in effective pixels with Microsoft's widget host config (text: 12/14/18/20/28 px, lines about 4/3 of
// that; spacing small 8, default 12). The body is the widget less the board's 48 px title row and 16 px padding:
// measured on the board in HaFeed (260 wide; 128 / 265 / 402 tall).
const LINE_SMALL: i32 = 16;
const LINE: i32 = 19;
const LINE_XL: i32 = 36;
fn room(size: WidgetSize) -> i32 { match size { WidgetSize::Small => 64, WidgetSize::Medium => 201, _ => 338 } }
/// Most click targets for a size (the widget itself is one of them).
fn targets(size: WidgetSize) -> usize { match size { WidgetSize::Small => 1, WidgetSize::Medium => 3, _ => 4 } }

/// The summaries the provider can fetch itself get a "רענון" button, on medium and large (a small one has 1 target).
fn refreshable(w: &W) -> bool {
    w.size != WidgetSize::Small && matches!(w.kind.as_str(), "weather" | "rates" | "transit" | "shipments" | "podcasts" | "youtube" | "forums")
}
fn refresh_actions(w: &W) -> Value {
    if !refreshable(w) { return json!([]) }
    json!([{ "type": "Action.Execute", "verb": "refresh", "title": "רענון", "tooltip": "רענון המידע עכשיו" }])
}
/// The widget's "רענון", on its own thread (network), pushed as the module's own rounds do (push / set_per re-render).
fn refresh(kind: &str, custom: &str) {
    let (kind, custom) = (kind.to_string(), custom.to_string());
    std::thread::spawn(move || {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        match kind.as_str() {
            "weather" if !custom.is_empty() => crate::bg::refresh_place(&custom),
            "weather" | "rates" => crate::bg::refresh(&kind),
            "transit" => crate::buses::refresh(),
            "shipments" => crate::shipments::check_now(),
            "podcasts" => crate::podcasts::refresh_now(),
            "youtube" => crate::youtube::refresh_now(),
            "forums" => crate::forums::poll_now(),
            _ => {}
        }
    });
}

/// Local wall clock of unix ms, in this computer's time zone: (days since 1970 of the local date, "HH:MM:SS").
fn local_hms(ms: i64) -> (i64, String) {
    #[repr(C)]
    #[derive(Default)]
    struct St { y: u16, mo: u16, dw: u16, d: u16, h: u16, mi: u16, s: u16, ms: u16 }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn FileTimeToSystemTime(ft: *const u64, st: *mut St) -> i32;
        fn SystemTimeToTzSpecificLocalTime(tz: *const core::ffi::c_void, u: *const St, l: *mut St) -> i32;
    }
    let ft = ((ms.div_euclid(1000) + 11644473600) * 10_000_000) as u64;
    let (mut u, mut l) = (St::default(), St::default());
    unsafe { FileTimeToSystemTime(&ft, &mut u); SystemTimeToTzSpecificLocalTime(core::ptr::null(), &u, &mut l); }
    (zmanim::days_from_civil(l.y as i64, l.mo as i64, l.d as i64), format!("{:02}:{:02}:{:02}", l.h, l.mi, l.s))
}
pub(crate) fn local(ms: i64) -> (i64, String) {
    let (d, mut hms) = local_hms(ms);
    hms.truncate(5);
    (d, hms)
}
fn local_hm(ms: i64) -> String { local(ms).1 }

/// How a zman is rounded (the user's decision, 15.11.26: "עיגול לחומרא"). The same ids as the page's TIMES.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Round {
    /// A deadline (sof zman): the seconds are dropped, so the time shown is never later than the real one.
    Down,
    /// A start: any seconds go to the next minute, so the time shown is never earlier than the real one.
    Up,
    /// Both ways (as sunset): no rounding is a chumra, so the seconds are shown.
    Sec,
}
pub(crate) fn round_of(id: &str) -> Round {
    match id {
        "shma_mga" | "shma_gra" | "tefila_mga" | "tefila_gra" => Round::Down,
        "misheyakir" | "mincha_gedola" | "mincha_ketana" | "tzeit" | "rt" => Round::Up,
        _ => Round::Sec,
    }
}
/// A zman as text: "HH:MM" rounded by its id, or "HH:MM:SS" for the both-ways times and when the user
/// asked for seconds (cards.zmanim.secs). With seconds, the deadlines and the starts still round to the
/// second in the strict direction.
pub(crate) fn zman_time(id: &str, ms: i64, secs: bool) -> String {
    let r = round_of(id);
    let step = if secs || r == Round::Sec { 1000 } else { 60_000 };
    let t = match r {
        Round::Down => ms.div_euclid(step) * step,
        Round::Up => (ms + step - 1).div_euclid(step) * step,
        Round::Sec => (ms + step / 2).div_euclid(step) * step,
    };
    let (_, hms) = local_hms(t);
    if step == 1000 { hms } else { hms[..5].to_string() }
}
/// Does the user want every zman with seconds ("להציג שניות" in the card's settings)?
pub(crate) fn zman_secs(st: &Value) -> bool { st["cards"]["zmanim"]["secs"].as_bool().unwrap_or(false) }
fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
fn left(ms: i64) -> String {
    let m = ((ms - now_ms() + 59_999) / 60_000).max(0);
    if m >= 60 { format!("עוד {}:{:02} שע'", m / 60, m % 60) } else { format!("עוד {m} דק'") }
}
/// A label at the start and a short value at the end, on one line.
fn pair(label: &str, value: &str, label_extra: Value, value_extra: Value, spacing: &str) -> Value {
    let mut le = json!({ "maxLines": 1 });
    let mut ve = json!({ "maxLines": 1, "weight": "Bolder" });
    for (o, e) in [(&mut le, label_extra), (&mut ve, value_extra)] {
        if let (Some(o), Some(e)) = (o.as_object_mut(), e.as_object()) { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
    }
    json!({ "type": "ColumnSet", "spacing": spacing, "columns": [
        { "type": "Column", "width": "stretch", "items": [text(label, le)] },
        { "type": "Column", "width": "auto", "items": [text(value, ve)] } ] })
}

// ---------- zmanim ----------
/// Every time of the board's zmanim card (web/src/cards/zmanim.js TIMES): id, name, default method, on by default.
const TIMES: [(&str, &str, &str, bool); 15] = [
    ("alot", "עלות השחר", "alot_90deg", true), ("misheyakir", "ציצית ותפילין", "misheyakir_11_5", true), ("netz", "הנץ", "sunrise", true),
    ("shma_mga", "סוזק\"ש מג\"א", "shma_mga_chumra", true), ("shma_gra", "סוזק\"ש גר\"א", "shma_gra", true),
    ("tefila_mga", "סוזת\"פ מג\"א", "tefila_mga_chumra", false), ("tefila_gra", "סוזת\"פ גר\"א", "tefila_gra", true),
    ("chatzot", "חצות היום", "chatzot", true), ("mincha_gedola", "מנחה גדולה", "mincha_gedola_30", true),
    ("mincha_ketana", "מנחה קטנה", "mincha_ketana_gra", false), ("plag", "פלג המנחה", "plag_gra", true),
    ("shkia", "שקיעה", "sunset", true), ("tzeit", "צאת הכוכבים", "tzeit_6_45", true), ("rt", "רבנו תם", "rt_72deg", true),
    ("chatzot_night", "חצות הלילה", "chatzot_night", false)];

/// The user's chosen times of one local day, in time order: (id, name, unix ms).
fn day_times(st: &Value, day: i64, lat: f64, lng: f64, elev: f64) -> Vec<(&'static str, &'static str, i64)> {
    let z = &st["cards"]["zmanim"];
    let mut d = zmanim::compute(day, lat, lng, elev);
    // The visible sunrise / sunset, when the horizon profile is on disk already (as /board/zmanim does).
    let skip = z["visKm"].as_f64().unwrap_or(2.0);
    for (k, rising) in [("sunrise_vis", true), ("sunset_vis", false)] {
        if crate::horizon::ready(lat, lng, rising) {
            if let Some(v) = crate::horizon::visible(day, lat, lng, rising, skip) { d.t.insert(k.into(), json!((v * 1000.0).round() as i64)); }
        }
    }
    let mut out: Vec<(&str, &str, i64)> = TIMES.iter().filter(|(id, _, _, on)| z["on"][*id].as_bool().unwrap_or(*on))
        .filter_map(|(id, name, def, _)| {
            let m = z["method"][*id].as_str().unwrap_or(def);
            // A visible time without its profile yet: the plain one, as the card does.
            d.t.get(m).and_then(Value::as_i64).or_else(|| d.t.get(*def).and_then(Value::as_i64)).map(|t| (*id, *name, t))
        }).collect();
    out.sort_by_key(|x| x.2);
    out
}

/// The next zman, large. With seconds, the ":SS" is smaller beside it (one RichTextBlock, one line), so
/// "HH:MM:SS" with the countdown still fits a small widget's width.
fn big_time(hms: &str) -> Value {
    let (hm, sec) = hms.split_at(hms.len().min(5));
    let mut runs = vec![json!({ "type": "TextRun", "text": hm, "size": "ExtraLarge", "weight": "Bolder" })];
    if !sec.is_empty() { runs.push(json!({ "type": "TextRun", "text": sec, "size": "Medium", "weight": "Bolder" })); }
    json!({ "type": "RichTextBlock", "inlines": runs })
}

/// Zmanim, computed here: the Hebrew date (from the page's last push), the next time with a countdown, and as
/// much of the user's chosen list as the size holds (the large one: the whole day, the past ones dimmed).
fn zmanim_card(w: &W) -> String {
    let st = settings();
    // The widget's own place (התאמה אישית), else the board's.
    let own = place_of(w);
    let (lat, lng, elev) = match &own {
        Some((_, la, ln, el)) => (*la, *ln, *el),
        None => {
            let (Some(lat), Some(lng)) = (st["lat"].as_f64(), st["lng"].as_f64()) else { return card(&w.kind, note(OPEN_BOARD), json!([])) };
            (lat, lng, st["elev"].as_f64().unwrap_or(0.0))
        }
    };
    let now = now_ms();
    let today = local(now).0;
    let mut times = day_times(&st, today, lat, lng, elev);
    // After the last time of the day: tomorrow's list.
    let tomorrow = !times.iter().any(|(_, _, t)| *t > now);
    if tomorrow { times = day_times(&st, today + 1, lat, lng, elev); }
    let next = times.iter().position(|(_, _, t)| *t > now);
    let hdate = s(&now_of(&data()["zmanim"])["hdate"]).to_string();
    // Another place: its name instead of the date (the times are not the board's place).
    let hdate = match &own { Some((n, ..)) => n.split(',').next().unwrap_or(n).to_string(), None => hdate };
    let Some(ni) = next else { return card(&w.kind, note("אין זמנים לחישוב במקום הזה."), json!([])) };
    let (id, name, t) = times[ni];
    let secs = zman_secs(&st);
    let name = if tomorrow { format!("{name} (מחר)") } else { name.to_string() };
    // The next time: its name (with the date beside it on a small widget), then the time large with the countdown.
    let mut body = vec![];
    if w.size == WidgetSize::Small {
        body.push(json!({ "type": "ColumnSet", "spacing": "None", "columns": [
            { "type": "Column", "width": "stretch", "items": [text(&name, json!({ "maxLines": 1 }))] },
            { "type": "Column", "width": "auto", "verticalContentAlignment": "Center", "items": [text(&hdate, json!({ "size": "Small", "isSubtle": true, "maxLines": 1 }))] } ] }));
    } else {
        if !hdate.is_empty() { body.push(text(&hdate, json!({ "size": "Small", "isSubtle": true, "maxLines": 1 }))); }
        body.push(text(&name, json!({ "spacing": if hdate.is_empty() { "None" } else { "Small" }, "maxLines": 1 })));
    }
    body.push(json!({ "type": "ColumnSet", "spacing": "None", "columns": [
        { "type": "Column", "width": "auto", "items": [big_time(&zman_time(id, t, secs))] },
        { "type": "Column", "width": "stretch", "verticalContentAlignment": "Center", "items": [text(&left(t), json!({ "isSubtle": true, "horizontalAlignment": "Left", "maxLines": 1 }))] } ] }));
    let head = if w.size == WidgetSize::Small { LINE + LINE_XL } else { LINE_SMALL + 8 + LINE + LINE_XL };
    let fit = ((room(w.size) - head) / LINE).max(0) as usize;
    let list: Vec<(usize, &(&str, &str, i64))> = match w.size {
        WidgetSize::Small => vec![],
        // Medium: the times after the next one.
        WidgetSize::Medium => times.iter().enumerate().skip(ni + 1).take(fit).collect(),
        // Large: the whole list; when it does not fit, the earliest past ones go first.
        _ => {
            let from = times.len().saturating_sub(fit).min(ni);
            times.iter().enumerate().skip(from).take(fit).collect()
        }
    };
    for (k, (i, (zid, n, tt))) in list.into_iter().enumerate() {
        let past = i < ni;
        let is_next = i == ni;
        let style = if past { json!({ "isSubtle": true }) } else if is_next { json!({ "color": "Accent" }) } else { json!({}) };
        let vstyle = if past { json!({ "isSubtle": true, "weight": "Default" }) } else if is_next { json!({ "color": "Accent" }) } else { json!({}) };
        body.push(pair(n, &zman_time(zid, *tt, secs), style, vstyle, if k == 0 { "Small" } else { "None" }));
    }
    card(&w.kind, Value::Array(body), json!([]))
}

// ---------- radio ----------
/// The radio: the station, the song, and text buttons (Action.Execute -> OnActionInvoked -> radio.rs).
/// Text, not icons: the board draws no SVG, and a picture of a glyph does not follow light and dark.
/// Small: play/stop only. Medium: play/stop and next (with the tap on the widget, 3 targets). Large: also previous.
fn radio_card(w: &W) -> String {
    // A widget set to one station (התאמה אישית): its name, and one button that plays or stops it.
    if !w.custom.is_empty() {
        let name = crate::radio::stations().into_iter().find(|x| x.0 == w.custom).map(|x| x.1);
        let Some(name) = name else { return card(&w.kind, note("התחנה הזאת כבר לא בלוח. בחרו אחרת בהתאמה האישית."), json!([])) };
        let on = crate::radio::playing_url() == w.custom;
        let small = w.size == WidgetSize::Small;
        let body = json!([text(&name, json!({ "weight": "Bolder", "size": if small { "Default" } else { "Medium" }, "maxLines": 1 })),
            text(if on { "משדר" } else { "עצור" }, json!({ "isSubtle": true, "spacing": "None" }))]);
        let act = if on { json!({ "type": "Action.Execute", "verb": "radio-stop", "title": "עצירה", "tooltip": "עצירת הרדיו" }) }
            else { json!({ "type": "Action.Execute", "verb": "radio-one", "title": "ניגון", "tooltip": format!("ניגון {name}") }) };
        if small { return card_only(body, json!([act])).to_string() }
        return card(&w.kind, body, json!([act]))
    }
    let st: Value = serde_json::from_str(&crate::radio::command("")).unwrap_or(json!({}));
    let playing = st["playing"].as_bool().unwrap_or(false);
    let name = if s(&st["name"]).is_empty() { "רדיו" } else { s(&st["name"]) };
    let small = w.size == WidgetSize::Small;
    let mut body = vec![text(name, json!({ "weight": "Bolder", "size": if small { "Default" } else { "Medium" }, "maxLines": 1 }))];
    if !small {
        let sub = if playing { if s(&st["title"]).is_empty() { "משדר" } else { s(&st["title"]) } } else if s(&st["name"]).is_empty() { "בחרו תחנה בלוח" } else { "עצור" };
        body.push(text(sub, json!({ "isSubtle": true, "maxLines": if w.size == WidgetSize::Large { 4 } else { 2 }, "spacing": "None" })));
        let sleep = st["sleepLeft"].as_i64().unwrap_or(0);
        if playing && sleep > 0 { body.push(text(&format!("כיבוי בעוד {} דק'", (sleep + 59) / 60), json!({ "size": "Small", "isSubtle": true, "spacing": "Small" }))); }
    }
    let play = if playing { json!({ "type": "Action.Execute", "verb": "radio-stop", "title": "עצירה", "tooltip": "עצירת הרדיו" }) }
        else { json!({ "type": "Action.Execute", "verb": "radio-play", "title": "ניגון", "tooltip": "ניגון התחנה" }) };
    let next = json!({ "type": "Action.Execute", "verb": "radio-next", "title": "הבאה", "tooltip": "התחנה הבאה" });
    let prev = json!({ "type": "Action.Execute", "verb": "radio-prev", "title": "קודמת", "tooltip": "התחנה הקודמת" });
    let actions = match w.size {
        WidgetSize::Small => json!([play]),
        WidgetSize::Medium => json!([play, next]),
        _ => json!([prev, play, next]),
    };
    // A small widget has one target, the button: there the widget itself opens nothing.
    if small { return card_only(Value::Array(body), actions).to_string() }
    card(&w.kind, Value::Array(body), actions)
}

// ---------- red alert ----------
/// Red alert: quiet when there is nothing (the medium one: the last alert here today); red with the towns during one.
fn redalert_card(w: &W) -> String {
    let st: Value = serde_json::from_str(&crate::redalert::state()).unwrap_or(json!({}));
    if st["reachable"] == json!(false) { return card(&w.kind, note("אין גישה לפיקוד העורף מהחיבור הזה."), json!([])) }
    let cur = &st["current"];
    // A widget set to one town (התאמה אישית): only its alerts (the same prefix match as redalert.rs wanted()).
    let one = |t: &str| w.custom.is_empty() || t.starts_with(w.custom.as_str()) || w.custom.starts_with(t);
    let mine_of = |x: &Value| -> Vec<String> { x["mine"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|t| one(t)).map(str::to_string).collect() };
    let fresh = cur["at"].as_i64().is_some_and(|t| now_ms() - t < 180_000) && !mine_of(cur).is_empty();
    if !fresh {
        let mut body = vec![text("● אין התרעות כרגע", json!({ "color": "Good", "weight": "Bolder" }))];
        if w.size != WidgetSize::Small {
            let today = local(now_ms()).0;
            let last = st["history"].as_array().into_iter().flatten()
                .find(|h| !mine_of(h).is_empty() && h["at"].as_i64().is_some_and(|t| local(t).0 == today));
            body.push(match last {
                Some(h) => text(&format!("היום ב-{}: {}", local_hm(h["at"].as_i64().unwrap_or(0)), s(&h["title"])), json!({ "isSubtle": true, "maxLines": 3, "spacing": "Small" })),
                None if !w.custom.is_empty() => text(&format!("לא היו התרעות ב{} היום.", w.custom), json!({ "isSubtle": true, "spacing": "Small" })),
                None => text("לא היו התרעות ביישובים שלכם היום.", json!({ "isSubtle": true, "spacing": "Small" })),
            });
        }
        return card(&w.kind, Value::Array(body), json!([]))
    }
    let n = match w.size { WidgetSize::Small => 3, _ => 12 };
    let all = mine_of(cur);
    let mut towns = all.iter().take(n).cloned().collect::<Vec<_>>().join(", ");
    if all.len() > n { towns += &format!(" ועוד {}", all.len() - n); }
    let mut items = vec![text(s(&cur["title"]), json!({ "weight": "Bolder", "size": if w.size == WidgetSize::Small { "Default" } else { "Medium" }, "color": "Attention", "maxLines": 1 })),
        text(&towns, json!({ "maxLines": if w.size == WidgetSize::Small { 1 } else { 5 }, "spacing": "None" }))];
    // The time to reach a protected space (the shortest among the user's towns), on every size.
    if let Some(t) = cur["shelter"].as_u64() { items.push(text(&format!("למרחב מוגן: {}", crate::redalert::shelter_text(t)), json!({ "weight": "Bolder", "spacing": "Small", "maxLines": 1 }))); }
    if w.size != WidgetSize::Small && !s(&cur["desc"]).is_empty() { items.push(text(s(&cur["desc"]), json!({ "isSubtle": true, "size": "Small", "maxLines": 2 }))); }
    card(&w.kind, json!([{ "type": "Container", "style": "attention", "bleed": true, "items": items }]), json!([]))
}

// ---------- the page's summaries ----------
/// Every other card: the page's summary { big, sub, rows: [[label, value, strong?, url?]] }, as much as the size holds.
/// A long value (an episode, a status) goes under its label instead of beside it. A row with a url opens it
/// (as many as the size's click targets allow, after the widget itself); every other tap opens the board.
fn summary_card(w: &W) -> String {
    let d = data();
    let mut own;
    let mut x = &d[&w.kind];
    if !w.custom.is_empty() && !x.is_null() {
        // The summary for now first (ahead), then its one-program/stop/currency entry; else the entry sent now.
        own = now_of(x)["per"][&w.custom].clone();
        if own.is_null() { own = x["per"][&w.custom].clone(); }
        x = &own;
        if x.is_null() {
            let t = match w.kind.as_str() {
                "weather" => "מביא את מזג האוויר למקום הזה...",
                "shabbat" => "הזמנים למקום הזה ייכנסו כשהלוח יתעדכן.",
                "rates" if !d["rates"]["per"].is_object() => "פתחו את הלוח פעם אחת כדי לעדכן את השערים.",
                "rates" => "המטבע הזה כבר לא בלוח. בחרו מטבע אחר בהתאמה האישית.",
                "learning" if !d["learning"]["per"].is_object() => "פתחו את הלוח פעם אחת",
                "learning" => "הלימוד הזה כבר לא בלוח. בחרו אחר בהתאמה האישית.",
                "forums" => "הפורום הזה כבר לא מחובר. בחרו אחר בהתאמה האישית.",
                "podcasts" => "הפודקאסט הזה כבר לא במעקב. בחרו אחר בהתאמה האישית.",
                "youtube" => "הערוץ הזה כבר לא במעקב. בחרו אחר בהתאמה האישית.",
                "shipments" => "המשלוח הזה כבר לא במעקב. בחרו אחר בהתאמה האישית.",
                "personal" => "התאריך הזה כבר לא ברשימה. בחרו אחר בהתאמה האישית.",
                _ => "התחנה הזאת כבר לא בלוח. בחרו תחנה אחרת בהתאמה האישית.",
            };
            return card(&w.kind, note(t), json!([]))
        }
    }
    if x.is_null() { return card(&w.kind, note(OPEN_BOARD), json!([])) }
    let x = &now_of(x);
    // Buses in real time: minutes from a while ago are wrong, so after 5 minutes they are not shown at all.
    let age = now_ms() - x["at"].as_i64().unwrap_or(0);
    if w.kind == "transit" && w.custom != "rail" && x["at"].as_i64().is_some() && age > 5 * 60_000 {
        return card(&w.kind, note(&format!("הזמנים מ-{} כבר לא נכונים. פותחים את הלוח כדי לעדכן.", local_hm(x["at"].as_i64().unwrap_or(0)))), refresh_actions(w))
    }
    // "(לפי Windows)" is for the board's place button; a widget has no room for it.
    let sub_t = s(&x["sub"]).replace(" (לפי Windows)", "");
    let (big, sub) = (s(&x["big"]), sub_t.as_str());
    let rows: Vec<&Value> = x["rows"].as_array().into_iter().flatten().collect();
    let mut body = vec![];
    let mut used = 0;
    let small = w.size == WidgetSize::Small;
    if !big.is_empty() {
        body.push(text(big, json!({ "size": "ExtraLarge", "weight": "Bolder", "maxLines": 1 })));
        used += LINE_XL;
    }
    if big.is_empty() && rows.is_empty() && !sub.is_empty() { return card(&w.kind, note(sub), json!([])) }
    if !sub.is_empty() {
        // Without a big line, the sub leads (and has the lines the big would have had).
        let lines = if small { if big.is_empty() { 3 } else { 1 } } else if big.is_empty() && rows.is_empty() { 6 } else { 2 };
        let lead = big.is_empty() && !rows.is_empty() && !small;
        body.push(text(sub, json!({ "isSubtle": !lead, "weight": if lead { "Bolder" } else { "Default" }, "spacing": "None", "maxLines": lines })));
        // About 34 characters a line at 14 px in the 228 px a widget has inside.
        used += LINE * lines.min((sub.chars().count() as i32 + 33) / 34).max(1);
    }
    // The "רענון" button is one of the targets too.
    let mut links = targets(w.size) - 1 - refreshable(w) as usize;
    // The button row under the body (about 32 px and 8 spacing; not measured on the board).
    let mut room_left = room(w.size) - used - if refreshable(w) { 40 } else { 0 };
    let mut shown = 0;
    for r in &rows {
        let (label, value) = (s(&r[0]), s(&r[1]));
        let strong = r.get(2).and_then(Value::as_bool).unwrap_or(false);
        let long = value.chars().count() > 18;
        let h = if long { LINE_SMALL + LINE + 8 } else { LINE + if shown == 0 { 8 } else { 0 } };
        if h > room_left { break }
        room_left -= h;
        let mut el = if long {
            json!({ "type": "Container", "spacing": "Small", "items": [
                text(label, json!({ "size": "Small", "isSubtle": true, "maxLines": 1 })),
                text(value, json!({ "maxLines": 1, "spacing": "None", "weight": if strong { "Bolder" } else { "Default" } })) ] })
        } else {
            pair(label, value, json!({ "isSubtle": !strong }), json!({}), if shown == 0 { "Small" } else { "None" })
        };
        let url = r.get(3).map(s).unwrap_or("");
        if links > 0 && url.starts_with("https://") {
            el["selectAction"] = json!({ "type": "Action.OpenUrl", "url": url, "tooltip": label });
            links -= 1;
        }
        body.push(el);
        shown += 1;
    }
    // A summary older than half an hour says so, where there is room (the page was not running since).
    let at = x["at"].as_i64().unwrap_or(0);
    if !small && at > 0 && now_ms() - at > 30 * 60_000 && room_left >= LINE_SMALL + 8 {
        let (day, hm) = local(at);
        let when = if day == local(now_ms()).0 { hm } else { format!("{hm}, לפני {} ימים", (local(now_ms()).0 - day).max(1)) };
        body.push(text(&format!("נכון ל-{when}"), json!({ "size": "Small", "isSubtle": true, "spacing": "Small", "maxLines": 1 })));
    }
    if body.is_empty() { body.push(text("אין מה להציג כרגע.", json!({ "isSubtle": true }))); }
    card(&w.kind, Value::Array(body), refresh_actions(w))
}

/// The radio widget's "התאמה אישית": one station (its own play button), or the board's player.
fn radio_pick(w: &W) -> String {
    let mut choices = vec![json!({ "title": "הנגן של הלוח", "value": "all" })];
    for (u, n, _) in crate::radio::stations() { choices.push(json!({ "title": n, "value": u })); }
    let hint = if choices.len() > 1 { "התחנות לפי הסדר שבכרטיס הרדיו." } else { "פתחו את הלוח פעם אחת, והתחנות יופיעו כאן." };
    card_only(json!([
        text("איזו תחנה בווידג'ט הזה", json!({ "weight": "Bolder" })),
        { "type": "Input.ChoiceSet", "id": "stop", "style": "compact", "value": if w.custom.is_empty() { "all" } else { &w.custom }, "choices": choices },
        text(hint, json!({ "size": "Small", "isSubtle": true, "spacing": "Small" })),
    ]), json!([
        { "type": "Action.Execute", "verb": "pick", "title": "שמירה" },
        { "type": "Action.Execute", "verb": "pick-cancel", "title": "ביטול" },
    ])).to_string()
}
/// The red alert widget's "התאמה אישית": one of the board's chosen towns, or all of them.
fn redalert_pick(w: &W) -> String {
    let st = settings();
    let mut choices = vec![json!({ "title": "כל היישובים שבלוח", "value": "all" })];
    for t in st["cards"]["redalert"]["towns"].as_array().into_iter().flatten().filter_map(Value::as_str) { choices.push(json!({ "title": t, "value": t })); }
    let hint = if choices.len() > 1 { "בוחרים יישובים בכרטיס צבע אדום שבלוח." } else { "בחרו יישובים בכרטיס צבע אדום שבלוח, והם יופיעו כאן." };
    card_only(json!([
        text("איזה יישוב להציג בווידג'ט הזה", json!({ "weight": "Bolder" })),
        { "type": "Input.ChoiceSet", "id": "stop", "style": "compact", "value": if w.custom.is_empty() { "all" } else { &w.custom }, "choices": choices },
        text(hint, json!({ "size": "Small", "isSubtle": true, "spacing": "Small" })),
    ]), json!([
        { "type": "Action.Execute", "verb": "pick", "title": "שמירה" },
        { "type": "Action.Execute", "verb": "pick-cancel", "title": "ביטול" },
    ])).to_string()
}
/// The transit widget's "התאמה אישית": one of the board's saved stops, or all of them.
fn transit_pick(w: &W) -> String {
    let st = settings();
    let mut choices = vec![json!({ "title": "כל התחנות שבלוח", "value": "all" })];
    for x in st["cards"]["transit"]["stops"].as_array().into_iter().flatten() {
        let code = x["code"].as_str().map(str::to_string).unwrap_or_else(|| x["code"].to_string());
        let name = s(&x["name"]);
        choices.push(json!({ "title": if name.is_empty() { code.clone() } else { format!("{name} ({code})") }, "value": code }));
    }
    let rail = &st["cards"]["transit"]["rail"];
    if rail["from"].is_object() && rail["to"].is_object() {
        choices.push(json!({ "title": format!("רכבת: {} > {}", s(&rail["from"]["name"]), s(&rail["to"]["name"])), "value": "rail" }));
    }
    let body = json!([
        text("מה להציג בווידג'ט הזה", json!({ "weight": "Bolder" })),
        { "type": "Input.ChoiceSet", "id": "stop", "style": "compact", "value": if w.custom.is_empty() { "all" } else { &w.custom }, "choices": choices },
        text("מוסיפים תחנות ומסלול רכבת בכרטיס התחבורה שבלוח.", json!({ "size": "Small", "isSubtle": true, "spacing": "Small" })),
    ]);
    card_only(body, json!([
        { "type": "Action.Execute", "verb": "pick", "title": "שמירה" },
        { "type": "Action.Execute", "verb": "pick-cancel", "title": "ביטול" },
    ])).to_string()
}



/// "התאמה אישית" that picks one entry of the summary's `per` (exchange rates, learning, forums): "הכל" or one.
/// `have`: the hint when there are choices; without any, the board has not sent them yet.
fn per_pick(w: &W, have: &str) -> String {
    let d = data();
    let mut choices = vec![json!({ "title": "הכל כמו בלוח", "value": "all" })];
    for (k, v) in d[&w.kind]["per"].as_object().into_iter().flatten() {
        let name = s(&v["name"]);
        choices.push(json!({ "title": if name.is_empty() { k.as_str() } else { name }, "value": k }));
    }
    let hint = if choices.len() > 1 { have } else { "פתחו את הלוח פעם אחת, והבחירות יופיעו כאן." };
    let body = json!([
        text("מה להציג בווידג'ט הזה", json!({ "weight": "Bolder" })),
        { "type": "Input.ChoiceSet", "id": "stop", "style": "compact", "value": if w.custom.is_empty() { "all" } else { &w.custom }, "choices": choices },
        text(hint, json!({ "size": "Small", "isSubtle": true, "spacing": "Small" })),
    ]);
    card_only(body, json!([
        { "type": "Action.Execute", "verb": "pick", "title": "שמירה" },
        { "type": "Action.Execute", "verb": "pick-cancel", "title": "ביטול" },
    ])).to_string()
}
/// The zmanim widget's "התאמה אישית": another place in Israel (a search, then a choice), or the board's place.
fn zmanim_pick(w: &W) -> String {
    let mut body = vec![
        text("המקום בווידג'ט הזה", json!({ "weight": "Bolder" })),
        json!({ "type": "Input.Text", "id": "q", "placeholder": "חיפוש עיר או יישוב בישראל" }),
    ];
    let mut choices = vec![json!({ "title": "המקום של הלוח", "value": "board" })];
    for (i, (n, ..)) in w.found.iter().enumerate() { choices.push(json!({ "title": n, "value": i.to_string() })); }
    let cur = place_of(w).map(|p| p.0);
    if let Some(c) = &cur { if w.found.is_empty() { choices.push(json!({ "title": c, "value": "keep" })); } }
    let value = if !w.found.is_empty() { "0" } else if cur.is_some() { "keep" } else { "board" };
    body.push(json!({ "type": "Input.ChoiceSet", "id": "pick", "style": "compact", "value": value, "choices": choices }));
    card_only(Value::Array(body), json!([
        { "type": "Action.Execute", "verb": "zm-search", "title": "חיפוש" },
        { "type": "Action.Execute", "verb": "zm-pick", "title": "שמירה" },
        { "type": "Action.Execute", "verb": "pick-cancel", "title": "ביטול" },
    ])).to_string()
}
/// The zmanim widget's own place (its CustomState: {"name","lat","lng"}), if it has one.
fn place_of(w: &W) -> Option<(String, f64, f64, f64)> {
    let v: Value = serde_json::from_str(&w.custom).ok()?;
    Some((s(&v["name"]).to_string(), v["lat"].as_f64()?, v["lng"].as_f64()?, v["elev"].as_f64().unwrap_or(0.0)))
}
/// Places in Israel by name (open-meteo's geocoder, as the board's place search).
fn geocode(q: &str) -> Vec<(String, f64, f64, f64)> {
    let enc: String = q.trim().bytes().map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let url = format!("https://geocoding-api.open-meteo.com/v1/search?name={enc}&count=6&language=he&countryCode=IL");
    let Some(r) = crate::http::fetch("GET", &url, "User-Agent: HaLuach\r\n", b"") else { return vec![] };
    let v: Value = serde_json::from_slice(&r.body).unwrap_or(json!({}));
    v["results"].as_array().into_iter().flatten().filter_map(|x| {
        let name = [s(&x["name"]), s(&x["admin1"])].into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join(", ");
        Some((name, x["latitude"].as_f64()?, x["longitude"].as_f64()?, x["elevation"].as_f64().unwrap_or(0.0)))
    }).collect()
}

pub fn render(w: &W) -> String {
    if w.editing && w.kind == "transit" { return transit_pick(w) }
    if w.editing && w.kind == "rates" { return per_pick(w, "מוסיפים מטבעות בכרטיס שערי המטבע שבלוח.") }
    if w.editing && w.kind == "learning" { return per_pick(w, "בוחרים לימודים בכרטיס הלימוד היומי שבלוח.") }
    if w.editing && w.kind == "forums" { return per_pick(w, "מתחברים לפורומים בכרטיס הפורומים שבלוח.") }
    if w.editing && w.kind == "podcasts" { return per_pick(w, "מוסיפים פודקאסטים בכרטיס הפודקאסטים שבלוח.") }
    if w.editing && w.kind == "youtube" { return per_pick(w, "מוסיפים ערוצים בכרטיס ערוצי יוטיוב שבלוח.") }
    if w.editing && w.kind == "shipments" { return per_pick(w, "מוסיפים משלוחים בכרטיס המשלוחים שבלוח.") }
    if w.editing && w.kind == "redalert" { return redalert_pick(w) }
    if w.editing && w.kind == "radio" { return radio_pick(w) }
    if w.editing && w.kind == "personal" { return per_pick(w, "מוסיפים תאריכים בכרטיס התאריכים האישיים שבלוח.") }
    if w.editing && (w.kind == "zmanim" || w.kind == "weather" || w.kind == "shabbat") { return zmanim_pick(w) }
    match w.kind.as_str() {
        "zmanim" => zmanim_card(w),
        "radio" => radio_card(w),
        "redalert" => redalert_card(w),
        _ => summary_card(w),
    }
}

/// Dev aid (haluach-widget.exe --widgets <out.json> [data folder]): every widget in every size it has, for
/// tools/widget-preview. The data folder defaults to data_dir(); the installed app keeps its own under
/// %LOCALAPPDATA%\Packages\HaLuachWidget_*\LocalCache\Local\HaLuach.
pub fn dump(out: &str, folder: Option<&str>) {
    if let Some(f) = folder { *DIR.lock().unwrap() = Some(f.into()); }
    let sizes = |k: &str| -> &[(&str, WidgetSize)] {
        const SML: &[(&str, WidgetSize)] = &[("small", WidgetSize::Small), ("medium", WidgetSize::Medium), ("large", WidgetSize::Large)];
        const SM: &[(&str, WidgetSize)] = &[("small", WidgetSize::Small), ("medium", WidgetSize::Medium)];
        const ML: &[(&str, WidgetSize)] = &[("medium", WidgetSize::Medium), ("large", WidgetSize::Large)];
        match k { "zmanim" | "shabbat" | "weather" | "transit" | "radio" => SML, "calendar" => ML, _ => SM }
    };
    let mut cards = vec![];
    for kind in ["zmanim", "shabbat", "weather", "radio", "rates", "transit", "shipments", "podcasts", "youtube", "learning", "personal", "calendar", "forums", "redalert"] {
        for (name, size) in sizes(kind) {
            let w = W { kind: kind.into(), size: *size, active: true, custom: String::new(), editing: false, found: vec![] };
            cards.push(json!({ "kind": kind, "size": name, "card": serde_json::from_str::<Value>(&render(&w)).unwrap_or(Value::Null) }));
        }
    }
    // A zmanim widget set to another place (Jerusalem, with its height), medium.
    let w = W { kind: "zmanim".into(), size: WidgetSize::Medium, active: true, custom: json!({ "name": "ירושלים, מחוז ירושלים", "lat": 31.769, "lng": 35.216, "elev": 786.0 }).to_string(), editing: false, found: vec![] };
    cards.push(json!({ "kind": "zmanim", "size": "own-place", "card": serde_json::from_str::<Value>(&render(&w)).unwrap_or(Value::Null) }));
    // The customization forms too (a sample search result for zmanim).
    for kind in ["transit", "zmanim", "rates", "learning", "forums", "podcasts", "shipments", "personal", "youtube", "redalert", "radio", "shabbat", "weather"] {
        let found = if kind == "zmanim" { vec![("ירושלים, מחוז ירושלים".into(), 31.769, 35.216, 786.0)] } else { vec![] };
        let w = W { kind: kind.into(), size: WidgetSize::Medium, active: true, custom: String::new(), editing: true, found };
        cards.push(json!({ "kind": kind, "size": "customize", "card": serde_json::from_str::<Value>(&render(&w)).unwrap_or(Value::Null) }));
    }
    // Each kind set to one choice (its first): the per entry, a town, a station.
    let d = data();
    for kind in ["rates", "learning", "forums", "podcasts", "shipments", "personal", "youtube", "redalert", "radio"] {
        let custom = match kind {
            "redalert" => s(&settings()["cards"]["redalert"]["towns"][0]).to_string(),
            "radio" => crate::radio::stations().first().map(|x| x.0.clone()).unwrap_or_default(),
            _ => d[kind]["per"].as_object().and_then(|m| m.keys().next().cloned()).unwrap_or_default(),
        };
        if custom.is_empty() { continue }
        let w = W { kind: kind.into(), size: WidgetSize::Medium, active: true, custom, editing: false, found: vec![] };
        cards.push(json!({ "kind": kind, "size": "one", "card": serde_json::from_str::<Value>(&render(&w)).unwrap_or(Value::Null) }));
    }
    let _ = std::fs::write(out, Value::Array(cards).to_string());
}

fn send(id: &str, w: &W) {
    let r = (|| -> windows_core::Result<()> {
        let o = WidgetUpdateRequestOptions::CreateInstance(&HSTRING::from(id))?;
        o.SetTemplate(&HSTRING::from(render(w)))?;
        o.SetData(&HSTRING::from("{}"))?;
        o.SetCustomState(&HSTRING::from(w.custom.as_str()))?;
        WidgetManager::GetDefault()?.UpdateWidget(&o)
    })();
    if let Err(e) = r { log(&format!("widget update {id}: {e}")); }
}
fn update_all() {
    for (id, x) in WIDGETS.lock().unwrap().iter().filter(|(_, x)| x.active) { send(id, x); }
}

fn from_ctx(ctx: &WidgetContext, custom: String) -> windows_core::Result<(String, W)> {
    Ok((ctx.Id()?.to_string_lossy(), W { kind: ctx.DefinitionId()?.to_string_lossy(), size: ctx.Size()?, active: ctx.IsActive()?, custom, editing: false, found: vec![] }))
}

#[implement(IWidgetProvider, IWidgetProvider2)]
pub struct Provider;

impl Provider {
    pub fn new() -> Self {
        static STARTED: AtomicBool = AtomicBool::new(false);
        if !STARTED.swap(true, Ordering::Relaxed) {
            if let Ok(infos) = WidgetManager::GetDefault().and_then(|m| m.GetWidgetInfos()) {
                let mut w = WIDGETS.lock().unwrap();
                for info in infos.iter().flatten() {
                    let custom = info.CustomState().map(|c| c.to_string_lossy()).unwrap_or_default();
                    if let Ok(Ok((id, x))) = info.WidgetContext().map(|c| from_ctx(&c, custom)) { w.insert(id, x); }
                }
            }
            std::thread::spawn(|| {
                let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
                // ponytail: one clock. Every 5 s the red alert and the radio; every minute everything (the countdowns).
                for tick in 0u64.. {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let all = tick % 12 == 0;
                    for (id, x) in WIDGETS.lock().unwrap().iter().filter(|(_, x)| x.active && (all || x.kind == "redalert" || x.kind == "radio")) { send(id, x); }
                }
            });
        }
        Provider
    }
}

impl IWidgetProvider_Impl for Provider_Impl {
    fn CreateWidget(&self, ctx: Ref<WidgetContext>) -> windows_core::Result<()> {
        let (id, x) = from_ctx(ctx.ok()?, String::new())?;
        send(&id, &x);
        WIDGETS.lock().unwrap().insert(id, x);
        Ok(())
    }
    fn DeleteWidget(&self, id: &HSTRING, _custom: &HSTRING) -> windows_core::Result<()> {
        WIDGETS.lock().unwrap().remove(&id.to_string_lossy());
        Ok(())
    }
    fn OnActionInvoked(&self, a: Ref<WidgetActionInvokedArgs>) -> windows_core::Result<()> {
        let a = a.ok()?;
        let id = a.WidgetContext()?.Id()?.to_string_lossy();
        match a.Verb()?.to_string_lossy().as_str() {
            // A tap on the widget: the board's page opens that card the next time it shows (as HaFeed's "open").
            "open" => {
                let d: Value = serde_json::from_str(&a.Data()?.to_string_lossy()).unwrap_or(json!({}));
                *GOTO.lock().unwrap() = s(&d["card"]).to_string();
                return Ok(());
            }
            "zm-search" => {
                let v: Value = serde_json::from_str(&a.Data()?.to_string_lossy()).unwrap_or(json!({}));
                let found = geocode(s(&v["q"]));
                if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id) { x.found = found; }
            }
            "zm-pick" => {
                let v: Value = serde_json::from_str(&a.Data()?.to_string_lossy()).unwrap_or(json!({}));
                if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id) {
                    match s(&v["pick"]) {
                        "board" => x.custom.clear(),
                        "keep" | "" => {}
                        i => if let Some((n, la, ln, el)) = i.parse::<usize>().ok().and_then(|i| x.found.get(i).cloned()) {
                            x.custom = json!({ "name": n, "lat": la, "lng": ln, "elev": el }).to_string();
                        },
                    }
                    x.editing = false; x.found.clear();
                    // Weather for the new place now, not in half an hour.
                    if x.kind == "weather" && !x.custom.is_empty() { let c = x.custom.clone(); std::thread::spawn(move || crate::bg::refresh_place(&c)); }
                }
            }
            "pick" | "pick-cancel" => {
                let v: Value = serde_json::from_str(&a.Data()?.to_string_lossy()).unwrap_or(json!({}));
                if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id) {
                    if a.Verb()? == "pick" { x.custom = match s(&v["stop"]) { "all" => String::new(), c => c.to_string() }; }
                    x.editing = false; x.found.clear();
                }
            }
            "refresh" => if let Some(x) = WIDGETS.lock().unwrap().get(&id) { refresh(&x.kind, &x.custom); },
            "radio-stop" => crate::radio::stop(),
            "radio-play" => crate::radio::resume(),
            "radio-one" => { let u = WIDGETS.lock().unwrap().get(&id).map(|x| x.custom.clone()); if let Some(u) = u { crate::radio::play_station(&u); } }
            "radio-next" => crate::radio::step(true),
            "radio-prev" => crate::radio::step(false),
            _ => {}
        }
        if let Some(x) = WIDGETS.lock().unwrap().get(&id) { send(&id, x); }
        Ok(())
    }
    fn OnWidgetContextChanged(&self, a: Ref<WidgetContextChangedArgs>) -> windows_core::Result<()> {
        let ctx = a.ok()?.WidgetContext()?;
        let id = ctx.Id()?.to_string_lossy();
        if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id) { x.size = ctx.Size()?; send(&id, x); }
        Ok(())
    }
    fn Activate(&self, ctx: Ref<WidgetContext>) -> windows_core::Result<()> {
        let id = ctx.ok()?.Id()?.to_string_lossy();
        if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id) { x.active = true; send(&id, x); }
        Ok(())
    }
    fn Deactivate(&self, id: &HSTRING) -> windows_core::Result<()> {
        if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id.to_string_lossy()) { x.active = false; }
        Ok(())
    }
}
impl IWidgetProvider2_Impl for Provider_Impl {
    // ponytail: transit (one stop), rates (one currency), learning (one program), podcasts/youtube/shipments/personal (one), shabbat (another place, computed by the page), zmanim and weather (another place) are customizable; the others follow the board's.
    fn OnCustomizationRequested(&self, a: Ref<WidgetCustomizationRequestedArgs>) -> windows_core::Result<()> {
        let id = a.ok()?.WidgetContext()?.Id()?.to_string_lossy();
        if let Some(x) = WIDGETS.lock().unwrap().get_mut(&id) { x.editing = true; send(&id, x); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zman_rounding() {
        let m = 1_763_200_000_000 / 60_000 * 60_000; // a whole minute (local zones are whole minutes)
        // Deadline: drop the seconds. Start: any second goes to the next minute. Exact minute stays.
        assert_eq!(zman_time("shma_gra", m + 59_999, false), zman_time("shma_gra", m, false));
        assert_eq!(zman_time("tzeit", m + 1, false), zman_time("shma_gra", m + 60_000, false));
        assert_eq!(zman_time("tzeit", m, false), zman_time("shma_gra", m, false));
        // Both ways: with seconds, rounded to the nearest second.
        assert_eq!(zman_time("shkia", m + 7_400, false), format!("{}:07", zman_time("shma_gra", m, false)));
        assert_eq!(zman_time("shkia", m + 7_600, false).len(), 8);
        // The user's "show seconds": every time HH:MM:SS, still in the strict direction.
        assert_eq!(zman_time("shma_gra", m + 7_900, true), format!("{}:07", zman_time("shma_gra", m, false)));
        assert_eq!(zman_time("tzeit", m + 7_100, true), format!("{}:08", zman_time("shma_gra", m, false)));
        assert_eq!(big_time("12:34:56")["inlines"].as_array().unwrap().len(), 2);
        assert_eq!(big_time("12:34")["inlines"].as_array().unwrap().len(), 1);
    }
}
