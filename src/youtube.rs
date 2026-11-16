// "ערוצי יוטיוב" while the page is closed (web/src/cards/youtube.js is the source of truth; this is its port).
// 2 minutes after start and then every settings interval (cards.youtube.everyMin, 60 by default), when a youtube widget
// is pinned or the "ערוצי יוטיוב" notification is on: the channels with their switch on are fetched from their video
// feed (youtube.com/feeds/videos.xml, the only source), the new videos are checked against NetFree as podcasts.rs does
// (418 = blocked), and a toast goes out for a new open video (with "התראה כשסרטון נפתח": also when a blocked one opens).
// With a widget pinned and the page's summary older than 90 minutes, every channel is fetched and the summary pushed.
// The data lives in data_dir()/youtube-seen.json (the page keeps its own in localStorage).
// Toast ids are 'yt-<video id>' ('-o' when it opened later), the page's ids, checked and recorded in the shared store
// (crate::notify::seen/mark) and in this file's own "_sent" list. Nothing goes out on shabbat or yom tov (crate::quiet_now).
use crate::podcasts::{cut, ep_open, get_text, merge, parse_feed};
use crate::{data_dir, http, log, widgets};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const UA: &str = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n";
const MAX: usize = 15;
const STALE_MS: i64 = 90 * 60_000;
const NEW_MS: i64 = 48 * 3_600_000;
const DAY: i64 = 86_400_000;

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }
fn s(v: &Value) -> String { v.as_str().unwrap_or("").to_string() }

pub fn start() {
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        std::thread::sleep(Duration::from_secs(120));
        loop {
            tick(false);
            let every = widgets::settings_value()["cards"]["youtube"]["everyMin"].as_u64().unwrap_or(60).max(15);
            std::thread::sleep(Duration::from_secs(every * 60));
        }
    });
}

struct Chan { id: String, name: String, notify: bool }

fn channels(c: &Value) -> Vec<Chan> {
    c["channels"].as_array().map(|a| a.iter().map(|x| Chan { id: s(&x["id"]), name: s(&x["name"]), notify: x["notify"].as_bool().unwrap_or(false) })
        .filter(|x| x.id.starts_with("UC")).collect()).unwrap_or_default()
}
fn name_of(ch: &Chan, data: &Value) -> String {
    if !ch.name.is_empty() && ch.name != ch.id { return ch.name.clone() }
    let n = s(&data[&ch.id]["name"]);
    if n.is_empty() { ch.id.clone() } else { n }
}

/// The widget's "רענון": the feeds now, and the widget's summary whatever its age.
pub fn refresh_now() { tick(true); }

/// One run at a time: refresh_now starts a thread on every tap of the widget.
static BUSY: AtomicBool = AtomicBool::new(false);
fn tick(force: bool) {
    struct Free;
    impl Drop for Free { fn drop(&mut self) { BUSY.store(false, Ordering::SeqCst); } }
    if BUSY.swap(true, Ordering::SeqCst) { return }
    let _free = Free;
    run(force);
}

fn run(force: bool) {
    if crate::quiet_now(0) { return }
    let st = widgets::settings_value();
    let c = &st["cards"]["youtube"];
    let list = channels(c);
    let notify = st["notify"]["youtube"].as_bool().unwrap_or(true); // planner.js NOTIFY: youtube on
    let pinned = widgets::has_kind("youtube");
    if !pinned && !(notify && list.iter().any(|x| x.notify)) { return }
    if list.is_empty() {
        if pinned { push_if_stale(json!({ "big": "", "sub": "אין ערוצים במעקב", "rows": [] }), force); }
        return;
    }
    let show_all = c["show"] == "all";
    let (reopen, shorts) = (c["reopen"].as_bool().unwrap_or(false), c["shorts"].as_bool().unwrap_or(false));
    let summary_due = pinned && (force || now_ms() - widgets::current()["youtube"]["at"].as_i64().unwrap_or(0) >= STALE_MS);
    let mut data = load();
    let now = now_ms();
    let mut pending: Vec<Value> = data["_pending"].as_array().cloned().unwrap_or_default();
    for ch in list.iter().filter(|x| (notify && x.notify) || summary_due) {
        let feed = get_text(&format!("https://www.youtube.com/feeds/videos.xml?channel_id={}&r={}", ch.id, now % 1_000_000)).and_then(|x| parse_feed(&x));
        match feed {
            Some(f) => {
                // Not seen for 48 hours (the app was off): a silent seed, as a first fetch.
                let old = &data[&ch.id];
                let seed = now - old["tried"].as_i64().unwrap_or(0).max(old["at"].as_i64().unwrap_or(0)) >= NEW_MS;
                let (mut entry, added) = merge(old, f, now);
                if let Some(a) = entry["eps"].as_array_mut() { a.truncate(MAX); }
                let young = |id: &String| entry["eps"].as_array().is_some_and(|a| a.iter().any(|e| e["id"] == id.as_str() && now - e["t"].as_i64().unwrap_or(0) < NEW_MS));
                if notify && ch.notify && !seed {
                    for id in added.iter().filter(|id| young(id)) { pending.push(json!({ "ch": ch.id, "id": id, "at": now })); }
                }
                data[&ch.id] = entry;
            }
            None => {
                log(&format!("youtube: {} failed", ch.id));
                if !data[&ch.id].is_object() { data[&ch.id] = json!({ "eps": [] }); }
                data[&ch.id]["failed"] = json!(true);
                data[&ch.id]["tried"] = json!(now);
            }
        }
    }
    let reopened = check(&list, &mut data, shorts);
    for (ch, id) in reopened { pending.push(json!({ "ch": ch, "id": id, "at": now, "reopen": true })); }

    // The alerts, as the page's checkAll.
    let mut sent: Vec<Value> = data["_sent"].as_array().cloned().unwrap_or_default();
    let mut keep = vec![];
    for p in pending.into_iter().rev().take(100).collect::<Vec<_>>().into_iter().rev() {
        let (chid, id, re) = (s(&p["ch"]), s(&p["id"]), p["reopen"] == true);
        let Some(ch) = list.iter().find(|x| x.id == chid) else { continue };
        let Some(i) = data[&chid]["eps"].as_array().and_then(|a| a.iter().position(|e| e["id"] == id.as_str())) else { continue };
        if !notify || !ch.notify { continue }
        let v = data[&chid]["eps"][i].clone();
        let young = now - p["at"].as_i64().unwrap_or(0) < 2 * DAY;
        if shorts && v["short"] != false { if v["short"].is_null() && young { keep.push(p); } continue }
        if !show_all && !re {
            if v["open"].is_null() { if young { keep.push(p); } continue }
            if v["open"] == false { if reopen { data[&chid]["eps"][i]["wait"] = json!(true); } continue }
        }
        if re && !reopen { continue }
        if re { data[&chid]["eps"][i]["wait"] = json!(false); } else if now - v["t"].as_i64().unwrap_or(0) >= NEW_MS { continue }
        let nid = format!("yt-{id}{}", if re { "-o" } else { "" });
        if sent.iter().any(|x| x == nid.as_str()) || crate::notify::seen(&nid) { continue }
        let name = name_of(ch, &data);
        let (title, body) = if re { (format!("נפתח: {}", s(&v["title"])), name) } else { (name, s(&v["title"])) };
        match crate::notify::toast(&title, &body, &format!("https://www.youtube.com/watch?v={id}"), "", "") {
            Ok(()) => { log(&format!("youtube: alert {nid}")); crate::notify::mark(&nid); sent.push(json!(nid)); }
            Err(e) => { log(&format!("youtube: toast failed: {e}")); if young { keep.push(p); } }
        }
    }
    let n = sent.len();
    data["_sent"] = json!(sent.into_iter().skip(n.saturating_sub(300)).collect::<Vec<_>>());
    data["_pending"] = json!(keep);
    data["_at"] = json!(now);
    save(&data);

    if summary_due { push(summary(&list, &data, show_all, shorts, now)); }
}

fn push(mut v: Value) {
    v["at"] = json!(now_ms());
    log("youtube: widget summary refreshed");
    widgets::push(&json!({ "youtube": v }).to_string());
}
fn push_if_stale(v: Value, force: bool) {
    let at = widgets::current()["youtube"]["at"].as_i64().unwrap_or(0);
    if force || now_ms() - at >= STALE_MS { push(v); }
}

/// shorts/<id> without following the redirect: a regular video redirects to /watch. 200 = a short; no answer = unknown.
fn is_short(id: &str) -> Option<bool> {
    let (r, _) = http::fetch_plain("HEAD", &format!("https://www.youtube.com/shorts/{id}"), UA, b"")?;
    Some(r.status == 200)
}

/// The page's check(): the newest unchecked videos (and blocked ones with a pending "נפתח"), at most 30 per run.
/// Returns (channel, video) of those that opened since the last check and wait for it.
fn check(list: &[Chan], data: &mut Value, shorts: bool) -> Vec<(String, String)> {
    let mut todo: Vec<(String, usize, bool, bool, (bool, i64))> = vec![];
    for ch in list {
        for (i, v) in data[&ch.id]["eps"].as_array().into_iter().flatten().take(10).enumerate() {
            let open = v["open"].is_null() || (v["open"] == false && v["wait"] == true);
            let short = shorts && v["short"].is_null();
            if open || short { todo.push((ch.id.clone(), i, open, short, (v["open"] == false, -v["t"].as_i64().unwrap_or(0)))); }
        }
    }
    todo.sort_by_key(|x| x.4);
    let (mut head_ok, mut gets, mut out) = (true, 0, vec![]);
    for (ch, i, open, short, _) in todo.into_iter().take(30) {
        let v = data[&ch]["eps"][i].clone();
        if short { if let Some(x) = is_short(&s(&v["id"])) { data[&ch]["eps"][i]["short"] = json!(x); } }
        if !open { continue }
        if let Some(o) = ep_open("ytp", &v, &mut head_ok, &mut gets) {
            data[&ch]["eps"][i]["open"] = json!(o);
            data[&ch]["eps"][i]["checked"] = json!(now_ms());
            if v["open"] == false && o && v["wait"] == true { out.push((ch, s(&v["id"]))); }
        }
    }
    out
}

/// The page's widget(): {big: "N חדשים", sub: "<channel>: <video>", rows, per}. New = first seen in the last 48 hours.
fn summary(list: &[Chan], data: &Value, show_all: bool, shorts: bool, now: i64) -> Value {
    let vis = |v: &Value| (show_all || v["open"] == true) && !(shorts && v["short"] == true);
    let is_new = |v: &Value| v["first"].as_i64().is_some_and(|f| f > 0 && now - f < NEW_MS);
    let mut all: Vec<(&Chan, &Value)> = list.iter().flat_map(|ch| data[&ch.id]["eps"].as_array().into_iter().flatten().filter(|v| vis(v)).map(move |v| (ch, v))).collect();
    all.sort_by_key(|(_, v)| -v["t"].as_i64().unwrap_or(0));
    let count = |x: &[&(&Chan, &Value)]| x.iter().filter(|(_, v)| is_new(v)).count();
    let big = |n: usize| if n > 0 { format!("{n} חדשים") } else { String::new() };
    let refs: Vec<&(&Chan, &Value)> = all.iter().collect();
    let per: serde_json::Map<String, Value> = list.iter().map(|ch| {
        let mine: Vec<&(&Chan, &Value)> = all.iter().filter(|(c, _)| c.id == ch.id).collect();
        (ch.id.clone(), json!({
            "name": name_of(ch, data), "big": big(count(&mine)),
            "sub": mine.first().map(|(_, v)| cut(&s(&v["title"]), 60)).unwrap_or_else(|| "אין סרטונים עדיין".into()),
            "rows": mine.iter().skip(1).take(3).map(|(_, v)| json!([cut(&s(&v["title"]), 40), "", is_new(v)])).collect::<Vec<_>>(),
        }))
    }).collect();
    json!({
        "big": big(count(&refs)),
        "sub": all.first().map(|(ch, v)| cut(&format!("{}: {}", name_of(ch, data), s(&v["title"])), 60)).unwrap_or_else(|| "אין סרטונים עדיין".into()),
        "rows": all.iter().take(4).map(|(ch, v)| json!([name_of(ch, data), cut(&s(&v["title"]), 40), is_new(v)])).collect::<Vec<_>>(),
        "per": per,
    })
}

fn path() -> std::path::PathBuf { data_dir().join("youtube-seen.json") }
fn load() -> Value {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(|v| v.is_object()).unwrap_or(json!({}))
}
fn save(v: &Value) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(path(), v.to_string());
}
