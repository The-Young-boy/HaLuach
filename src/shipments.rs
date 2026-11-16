// Shipment tracking with the board page closed. The page (web/src/cards/shipments.js checkAll, app.js liveChecks)
// does the same while it lives; both sides send through the sent-ids store (notify::seen/mark) with the page's id
// (`ship` + number + status, first 80 UTF-16 units), so a change goes out once from either side.
// First run 3 minutes after start, then every cards.shipments.everyMin minutes (default 60). Only Cainiao numbers.
// The last state per number: data_dir()/shipments-state.json {number: {latestAt, latest, statusText, delivered, deliveredAt}}.
// Nothing goes out on shabbat or yom tov (crate::quiet_now).
use crate::{http, log, widgets};
use serde_json::{json, Value};
use std::time::Duration;

const UA: &str = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\nAccept: application/json\r\n";

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

pub fn start() {
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        std::thread::sleep(Duration::from_secs(3 * 60));
        loop {
            let s = card(&widgets::settings_value());
            if let Err(e) = tick(&s, false, false) { log(&format!("shipments: {e}")); }
            std::thread::sleep(Duration::from_secs(every_min(&s) * 60));
        }
    });
}

/// Dev aid (--shipments-once <data folder>): what a round would send and push now. No toast, no writes.
pub fn once(folder: Option<&str>) {
    if let Some(f) = folder { widgets::set_dir(f); let _ = DIR.set(f.into()); }
    let s = card(&widgets::settings_value());
    if let Err(e) = tick(&s, true, false) { println!("error: {e}"); }
}

fn card(st: &Value) -> Value {
    let mut s = json!({ "items": [], "delivered": "keep", "hideDays": 7, "lang": "he-IL", "everyMin": 60, "_notify": true });
    if let (Some(o), Some(u)) = (s.as_object_mut(), st["cards"]["shipments"].as_object()) { for (k, v) in u { o.insert(k.clone(), v.clone()); } }
    // settings.notify.shipments (planner.js NOTIFY default: on).
    s["_notify"] = json!(st["notify"]["shipments"].as_bool() != Some(false));
    s
}
fn every_min(s: &Value) -> u64 { s["everyMin"].as_u64().filter(|m| *m >= 5).unwrap_or(60) }

/// shipments.js norm(): upper case, no spaces or dashes.
fn norm(n: &str) -> String { n.to_uppercase().chars().filter(|c| !c.is_whitespace() && *c != '-').collect() }

// ---------- carriers (shipments.js CARRIERS, first match wins) ----------
fn up(c: char) -> bool { c.is_ascii_uppercase() }
fn dig(c: char) -> bool { c.is_ascii_digit() }
fn word(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' }
fn all(s: &str, f: fn(char) -> bool) -> bool { s.chars().all(f) }
fn digits(s: &str, lo: usize, hi: usize) -> bool { (lo..=hi).contains(&s.len()) && all(s, dig) }
fn pre<'a>(n: &'a str, p: &str) -> Option<&'a str> { n.strip_prefix(p) }
/// [A-Z]{2}\d{9}<tail>
fn upu(n: &str, tail: fn(&str) -> bool) -> bool {
    let c: Vec<char> = n.chars().collect();
    c.len() == 13 && up(c[0]) && up(c[1]) && c[2..11].iter().all(|x| dig(*x)) && tail(&n[11..])
}

/// The carrier id of a normalized number and whether Cainiao tracks it.
fn detect(n: &str) -> (&'static str, bool) {
    let ok = |p: &str, f: &dyn Fn(&str) -> bool| pre(n, p).is_some_and(|r| f(r));
    if ok("LP", &|r| digits(r, 12, 16)) || ok("CN", &|r| r.len() >= 8 && all(r, |c| up(c) || dig(c)))
        || ok("CAINIAO", &|r| !r.is_empty() && all(r, word)) || ok("AE", &|r| digits(r, 10, usize::MAX))
        || ok("CNG", &|r| !r.is_empty() && all(r, word)) || ok("ALS", &|r| digits(r, 1, usize::MAX)) { return ("cainiao", true) }
    if upu(n, |t| t == "CN") { return ("chinapost", true) }
    if ok("YT", &|r| digits(r, 16, 16)) { return ("yun", true) }
    if ok("4PX", &|r| !r.is_empty() && all(r, word)) { return ("cainiao4px", true) }
    if upu(n, |t| t == "IL") { return ("israelpost", false) }
    if ok("1Z", &|r| r.len() == 16 && all(r, |c| up(c) || dig(c))) { return ("ups", false) }
    if ok("TBA", &|r| digits(r, 9, 13)) { return ("amazon", false) }
    if digits(n, 10, 10) || ok("JD", &|r| digits(r, 16, 18)) || ok("JJD", &|r| digits(r, 1, usize::MAX)) || ok("GM", &|r| digits(r, 16, 20)) { return ("dhl", false) }
    if [12, 15, 20, 22].contains(&n.len()) && all(n, dig) { return ("fedex", false) }
    if upu(n, |t| t.len() == 2 && all(t, up)) { return ("upu", true) }
    ("other", true)
}
fn cainiao_of(it: &Value) -> bool {
    match it["carrier"].as_str() {
        Some("cainiao" | "chinapost" | "yun" | "cainiao4px" | "upu" | "other") => true,
        Some("israelpost" | "ups" | "amazon" | "dhl" | "fedex" | "hfd" | "chita" | "boxit") => false,
        _ => detect(&norm(it["number"].as_str().unwrap_or(""))).1,
    }
}

// ---------- Cainiao ----------
fn delivered_re(s: &str) -> bool { let u = s.to_uppercase(); u.contains("SIGN") || u.contains("DELIVER") }
/// JS Date.parse("yyyy-mm-ddThh:mm:ss") as local time; 0 when it does not parse.
fn parse_local(s: &str) -> i64 {
    let n: Vec<i64> = s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).filter_map(|x| x.parse().ok()).collect();
    if n.len() < 5 { return 0 }
    let (y, m, d) = (n[0], n[1], n[2]);
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let days = 365 * y2 + y2 / 4 - y2 / 100 + y2 / 400 + (153 * m2 + 2) / 5 + d - 1 - 719_468;
    // Israel time (+2, +3 in summer is close enough for ordering; Cainiao sends `time` in ms almost always).
    (days * 86_400 + n[3] * 3600 + n[4] * 60 + n.get(5).copied().unwrap_or(0) - 2 * 3600) * 1000
}
/// shipments.js parseCainiao(m), the parts kept here.
fn parse(m: &Value) -> Value {
    let mut ev: Vec<(i64, String, String)> = m["detailList"].as_array().into_iter().flatten().map(|d| {
        let t = d["time"].as_i64().filter(|t| *t != 0).unwrap_or_else(|| parse_local(d["timeStr"].as_str().unwrap_or("")));
        let desc = d["desc"].as_str().filter(|x| !x.is_empty()).or(d["standerdDesc"].as_str()).unwrap_or("").to_string();
        (t, desc, d["actionCode"].as_str().unwrap_or("").to_string())
    }).collect();
    ev.sort_by(|a, b| b.0.cmp(&a.0));
    let latest = ev.first();
    let status = m["status"].as_str().unwrap_or("");
    let delivered = delivered_re(status) || latest.is_some_and(|l| delivered_re(&l.2));
    let st_text = m["statusDesc"].as_str().filter(|x| !x.is_empty()).map(String::from)
        .or_else(|| latest.map(|l| l.1.clone()).filter(|x| !x.is_empty()))
        .unwrap_or_else(|| if ev.is_empty() { "אין מידע עדיין".into() } else { String::new() });
    let at = latest.map(|l| l.0).unwrap_or(0);
    json!({ "latestAt": at, "latest": latest.map(|l| l.1.as_str()).unwrap_or(""), "statusText": st_text,
            "delivered": delivered, "deliveredAt": if delivered { if at > 0 { at } else { now_ms() } } else { 0 } })
}
fn fetch(numbers: &[String], lang: &str) -> Result<serde_json::Map<String, Value>, String> {
    let mut out = serde_json::Map::new();
    for chunk in numbers.chunks(10) {
        let url = format!("https://global.cainiao.com/global/detail.json?mailNos={}&lang={}", chunk.join(","), lang);
        let r = http::fetch("GET", &url, UA, b"").ok_or("cainiao: no reply")?;
        if r.status != 200 { return Err(format!("cainiao: {}", r.status)) }
        let d: Value = serde_json::from_slice(&r.body).map_err(|_| "cainiao: not json")?;
        if d["success"].as_bool() != Some(true) { return Err("cainiao: no success".into()) }
        for m in d["module"].as_array().into_iter().flatten() { out.insert(norm(m["mailNo"].as_str().unwrap_or("")), parse(m)); }
    }
    Ok(out)
}

// ---------- one round ----------
static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
fn state_path() -> std::path::PathBuf { DIR.get().cloned().unwrap_or_else(crate::data_dir).join("shipments-state.json") }

/// The widget's "רענון": a round now, and the widget's summary even when the page's is fresh.
pub fn check_now() {
    if let Err(e) = tick(&card(&widgets::settings_value()), false, true) { log(&format!("shipments: {e}")); }
}

/// `force`: push the widget's summary whatever the page's age (the widget's "רענון").
/// One round at a time: the widget's "רענון" (check_now) and the loop must not both write shipments-state.json
/// or send the same toast twice. Held for the whole round.
static TICK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn tick(s: &Value, dry: bool, force: bool) -> Result<(), String> {
    let _one = TICK.lock().unwrap_or_else(|e| e.into_inner());
    if !dry && crate::quiet_now(0) { return Ok(()) }
    let items: Vec<&Value> = s["items"].as_array().into_iter().flatten().filter(|it| cainiao_of(it)).collect();
    let notify_on = s["_notify"].as_bool() == Some(true);
    let pinned = widgets::has_kind("shipments");
    if dry { println!("cainiao items: {}, notify: {notify_on}, widget pinned: {pinned}", items.len()); }
    if items.is_empty() || (!dry && !notify_on && !pinned) { return Ok(()) }
    let mut state: Value = std::fs::read(state_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({}));
    let numbers: Vec<String> = items.iter().map(|it| norm(it["number"].as_str().unwrap_or(""))).collect();
    let got = fetch(&numbers, s["lang"].as_str().unwrap_or("he-IL"))?;
    for it in &items {
        let n = norm(it["number"].as_str().unwrap_or(""));
        let Some(now) = got.get(&n) else { if dry { println!("{n}: no data") } continue };
        let before = &state[&n];
        if dry { println!("{n}: {now}"); }
        if !before.is_null() && now["latestAt"].as_i64().unwrap_or(0) > before["latestAt"].as_i64().unwrap_or(0) && notify_on {
            let status = now["latest"].as_str().filter(|x| !x.is_empty()).or(now["statusText"].as_str()).unwrap_or("").to_string();
            let id = String::from_utf16_lossy(&format!("ship{n}{status}").encode_utf16().take(80).collect::<Vec<u16>>());
            let name = it["name"].as_str().filter(|x| !x.is_empty()).unwrap_or(&n).to_string();
            let url = format!("https://global.cainiao.com/newDetail.htm?mailNoList={n}");
            if dry { println!("would send [{id}] seen={}: משלוח: {name} / {status}", crate::notify::seen(&id)); }
            else if !crate::notify::seen(&id) {
                match crate::notify::toast(&format!("משלוח: {name}"), &status, &url, "", "") {
                    Ok(()) => { crate::notify::mark(&id); log(&format!("shipments: sent {id}")); }
                    Err(e) => log(&format!("shipments: toast {e}")),
                }
            }
        }
        let mut v = now.clone();
        if let Some(d) = before["deliveredAt"].as_i64().filter(|d| *d > 0) { v["deliveredAt"] = json!(d); }
        state[&n] = v;
    }
    if !dry {
        let _ = std::fs::create_dir_all(crate::data_dir());
        let _ = std::fs::write(state_path(), state.to_string());
    }
    // The widget, only when the page's summary is old (the page pushes its own while it lives).
    let page_at = widgets::current()["shipments"]["at"].as_i64().unwrap_or(0);
    if force || now_ms() - page_at > 2 * every_min(s) as i64 * 60_000 {
        let mut w = summary(s, &state, now_ms());
        w["at"] = json!(now_ms());
        if dry { println!("would push widget: {w}"); } else if pinned { widgets::push(&json!({ "shipments": w }).to_string()); }
    } else if dry { println!("widget: the page's summary is fresh"); }
    Ok(())
}

fn cut(t: &str, n: usize) -> String {
    let t = t.trim();
    if t.encode_utf16().count() > n { format!("{}…", String::from_utf16_lossy(&t.encode_utf16().take(n - 1).collect::<Vec<u16>>())) } else { t.to_string() }
}
/// shipments.js widgetSummary(s, data).
fn summary(s: &Value, data: &Value, now: i64) -> Value {
    let hide = s["delivered"].as_str() == Some("hide");
    let days = s["hideDays"].as_f64().unwrap_or(7.0);
    let items: Vec<&Value> = s["items"].as_array().into_iter().flatten().filter(|it| {
        let d = &data[norm(it["number"].as_str().unwrap_or(""))];
        let at = d["deliveredAt"].as_i64().unwrap_or(0);
        !(hide && d["delivered"].as_bool() == Some(true) && at > 0 && (now - at) as f64 > days * 864e5)
    }).collect();
    if items.is_empty() { return json!({ "big": "0", "sub": "כל המשלוחים נמסרו", "rows": [] }) }
    let (mut on_way, mut latest): (usize, Option<(i64, String)>) = (0, None);
    let mut rows = vec![];
    for it in items {
        let n = norm(it["number"].as_str().unwrap_or(""));
        let d = &data[&n];
        let name = it["name"].as_str().filter(|x| !x.is_empty()).unwrap_or(&n).to_string();
        let delivered = d["delivered"].as_bool() == Some(true);
        let text = d["latest"].as_str().filter(|x| !x.is_empty()).or(d["statusText"].as_str()).unwrap_or("");
        let at = d["latestAt"].as_i64().unwrap_or(0);
        if !delivered { on_way += 1; }
        if at > 0 && latest.as_ref().is_none_or(|l| at > l.0) { latest = Some((at, format!("{name}: {text}"))); }
        let val = if !cainiao_of(it) { "מעקב בדף החברה".to_string() } else if d.is_null() { "...".into() } else if delivered { "✓ נמסר".into() } else { cut(text, 38) };
        rows.push(json!([name, val, at > 0 && now - at < 86_400_000 && !delivered]));
    }
    json!({ "big": format!("{on_way} בדרך"), "sub": latest.map(|l| cut(&l.1, 60)).unwrap_or_else(|| "אין עדכון עדיין".into()), "rows": rows })
}
