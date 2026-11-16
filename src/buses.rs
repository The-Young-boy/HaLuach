// Buses for the transit widget with the board closed: curlbus.app per saved stop, once a minute, only while a
// transit widget is active (on the visible board) and the page's summary is over 2 minutes old. The texts are
// web/src/cards/transit.js `widget()`'s (big "line · minutes", rows "קו X לY"), and the same `per` (one stop per
// widget). With no visits (light-rail stops) or curlbus failing: the planned timetable from Hasadna Stride, as the
// page does. The rail route stays the page's (kept as it is in `per.rail`).
use crate::{http, log, widgets};
use serde_json::{json, Value};
use std::time::Duration;

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

pub fn start() {
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        loop {
            std::thread::sleep(Duration::from_secs(60));
            if !widgets::has_active("transit") || crate::quiet_now(0) { continue }
            let d = widgets::current();
            if now_ms() - d["transit"]["at"].as_i64().unwrap_or(0) < 2 * 60_000 { continue }
            if let Some(v) = summary(&d["transit"]) { widgets::push(&json!({ "transit": v }).to_string()); }
        }
    });
}

/// The widget's "רענון": the buses now, without the 2-minute rule.
pub fn refresh() {
    if let Some(v) = summary(&widgets::current()["transit"]) { widgets::push(&json!({ "transit": v }).to_string()); }
}

/// Dev aid (--buses <data folder>): the summary this would push, printed.
pub fn once(folder: &str) { widgets::set_dir(folder); println!("{}", summary(&json!({})).map(|v| v.to_string()).unwrap_or("-".into())); }

/// "2026-11-15 05:08:00+02:00" -> unix ms.
pub fn eta_ms(s: &str) -> Option<i64> {
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let days = crate::zmanim::days_from_civil(n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let secs = days * 86400 + n(11, 13)? * 3600 + n(14, 16)? * 60 + n(17, 19)?;
    let off = match s.get(19..20) { Some("+") => n(20, 22)? * 3600 + n(23, 25)? * 60, Some("-") => -(n(20, 22)? * 3600 + n(23, 25)? * 60), _ => 0 };
    Some((secs - off) * 1000)
}
fn in_min(m: i64) -> String { match m { i64::MIN..=0 => "עכשיו".into(), 1 => "דקה".into(), _ => format!("{m} דק'") } }

/// The widget's summary from the saved stops, or None when there are none or curlbus failed for all.
fn summary(old: &Value) -> Option<Value> {
    let st = widgets::settings_value();
    let stops: Vec<(String, String)> = st["cards"]["transit"]["stops"].as_array().into_iter().flatten()
        .map(|x| (x["code"].as_str().map(str::to_string).unwrap_or_else(|| x["code"].to_string()), x["name"].as_str().unwrap_or("").to_string())).collect();
    if stops.is_empty() { return None }
    let now = now_ms();
    let mut per = old["per"].as_object().cloned().unwrap_or_default();
    // (minutes, line, dest, stop name, stop index, label)
    let mut all: Vec<(i64, String, String, String, usize, String)> = vec![];
    let mut any = false;
    let mut ids = load_ids();
    for (i, (code, saved)) in stops.iter().enumerate() {
        // curlbus: (stop name, [(minutes, line, dest, label)]).
        let live = http::fetch("GET", &format!("https://curlbus.app/{code}"), "Accept: application/json\r\nUser-Agent: HaLuach\r\n", b"").filter(|r| r.status == 200)
            .and_then(|r| serde_json::from_slice::<Value>(&r.body).ok()).map(|d| {
                let mine: Vec<(i64, String, String, String)> = d["visits"][code.as_str()].as_array().into_iter().flatten().filter_map(|v| {
                    let m = (eta_ms(v["eta"].as_str()?)? - now) / 60_000;
                    (m >= -1).then(|| (m, v["line_name"].as_str().unwrap_or("").to_string(), v["static_info"]["route"]["destination"]["name"]["HE"].as_str().unwrap_or("").to_string(), String::new()))
                }).filter(|x| !x.1.is_empty()).collect();
                (d["stop_info"]["name"]["HE"].as_str().unwrap_or("").to_string(), mine)
            });
        // The planned timetable when curlbus failed or has no visits (light-rail stops), as the page's stopData().
        let got = if live.as_ref().is_some_and(|x| !x.1.is_empty()) { live } else {
            match planned(code, &mut ids, now) {
                Some(q) if !q.1.is_empty() || live.is_none() => Some((live.map(|x| x.0).filter(|n| !n.is_empty()).unwrap_or(q.0), q.1)),
                _ => live,
            }
        };
        let Some((sname, mut mine)) = got else { continue };
        any = true;
        let name = if !saved.is_empty() { saved.clone() } else if !sname.is_empty() { sname } else { code.clone() };
        mine.sort();
        let rows: Vec<Value> = mine.iter().take(8).map(|(m, l, dest, lb)| json!([format!("{} {}", label(l, lb), if dest.is_empty() { String::new() } else { format!("ל{dest}") }), in_min(*m), *m <= 2])).collect();
        let big = mine.first().map(|(m, l, ..)| format!("{l} · {}", in_min(*m))).unwrap_or_else(|| "אין אוטובוסים".into());
        per.insert(code.clone(), json!({ "big": big, "sub": name, "rows": rows, "at": now }));
        all.extend(mine.into_iter().map(|(m, l, dest, lb)| (m, l, dest, name.clone(), i, lb)));
    }
    if !any { log("buses: curlbus and stride failed for every stop"); return None }
    all.sort();
    let many = stops.len() > 1;
    let rows: Vec<Value> = all.iter().take(8).map(|(m, l, dest, stop, _, lb)| json!([format!("{} {}", label(l, lb), if many { stop.clone() } else if dest.is_empty() { String::new() } else { format!("ל{dest}") }), in_min(*m), *m <= 2])).collect();
    let first = all.iter().find(|x| x.4 == 0);
    let big = first.map(|(m, l, ..)| format!("{l} · {}", in_min(*m))).unwrap_or_else(|| "אין אוטובוסים".into());
    let sub = per.get(&stops[0].0).and_then(|x| x["sub"].as_str()).unwrap_or(&stops[0].0).to_string();
    Some(json!({ "big": big, "sub": sub, "rows": rows, "per": per, "at": now }))
}

/// A row's line text: "רכבת קלה · אדום" for light rail, else "קו X" (the page's `v.label || קו ${v.line}`).
fn label(line: &str, lb: &str) -> String { if lb.is_empty() { format!("קו {line}") } else { lb.to_string() } }

// ---------- planned times: Hasadna Stride GTFS (web/src/cards/transit.js planned()/parseStride()) ----------
const STRIDE: &str = "https://open-bus-stride-api.hasadna.org.il";
const SH: &str = "Accept: application/json\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n";
const COLOURS: [&str; 8] = ["אדום", "ירוק", "סגול", "כחול", "צהוב", "כתום", "חום", "ורוד"];

fn ids_path() -> std::path::PathBuf { crate::data_dir().join("stride-stops.json") }
/// The GTFS stop ids per stop code: { code: { ids: [..], name } }.
fn load_ids() -> serde_json::Map<String, Value> { std::fs::read(ids_path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default() }
fn stride(q: &str) -> Option<Vec<Value>> {
    let r = http::fetch("GET", &format!("{STRIDE}/{q}"), SH, b"").filter(|r| r.status == 200)?;
    serde_json::from_slice::<Value>(&r.body).ok()?.as_array().cloned()
}
/// Unix ms -> "2026-11-15T03:08:00Z".
fn iso(ms: i64) -> String {
    let s = ms.div_euclid(1000);
    let (y, m, d) = crate::zmanim::civil_from_days(s.div_euclid(86400));
    let t = s.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", t / 3600, t / 60 % 60, t % 60)
}
/// "A-city<->B-city-10" -> "B" (the page's gtfsDest).
fn gtfs_dest(n: &str) -> String {
    let b = n.rsplit("<->").next().unwrap_or("");
    let b = match b.rfind('-') { Some(i) if i + 1 < b.len() && b[i + 1..].chars().all(|c| c.is_ascii_digit()) => &b[..i], _ => b };
    match b.rfind('-') { Some(i) if i > 0 => b[..i].trim().to_string(), _ => b.trim().to_string() }
}
/// The next 90 minutes at a stop from the planned timetable: (stop name, [(minutes, line, dest, label)]).
/// The stop ids are kept per code on disk.
fn planned(code: &str, ids: &mut serde_json::Map<String, Value>, now: i64) -> Option<(String, Vec<(i64, String, String, String)>)> {
    if !ids.get(code).and_then(|x| x["ids"].as_array()).is_some_and(|a| !a.is_empty()) {
        // The local date (this computer's time zone, DST included).
        let (y, m, d) = crate::zmanim::civil_from_days(crate::widgets::local(now).0);
        let date = format!("{y:04}-{m:02}-{d:02}");
        let rows = stride(&format!("gtfs_stops/list?code={code}&date_from={date}&date_to={date}"))?;
        let mut v: Vec<i64> = rows.iter().filter_map(|r| r["id"].as_i64()).collect();
        v.sort();
        v.dedup();
        if v.is_empty() { return None }
        ids.insert(code.to_string(), json!({ "ids": v, "name": rows[0]["name"].as_str().unwrap_or("") }));
        let _ = std::fs::create_dir_all(crate::data_dir());
        let _ = std::fs::write(ids_path(), Value::Object(ids.clone()).to_string());
    }
    let st = &ids[code];
    let list = st["ids"].as_array()?.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",");
    let rows = stride(&format!("gtfs_ride_stops/list?gtfs_stop_ids={list}&arrival_time_from={}&arrival_time_to={}&expand_related=true&limit=200", iso(now - 60_000), iso(now + 90 * 60_000)))?;
    let mut seen = std::collections::HashSet::new();
    let out = rows.iter().filter(|r| seen.insert(r["gtfs_ride_id"].to_string())).filter_map(|r| {
        let s = |k: &str| r[k].as_str().map(str::to_string).unwrap_or_else(|| if r[k].is_null() { String::new() } else { r[k].to_string() });
        let (short, long, agency) = (s("gtfs_route__route_short_name"), s("gtfs_route__route_long_name"), s("gtfs_route__agency_name"));
        if short.is_empty() { return None }
        let lr = s("gtfs_route__route_type") == "0" || agency.contains("תבל") || agency.contains("כפיר");
        let label = if !lr { String::new() } else {
            match COLOURS.iter().find(|c| short.contains(*c) || long.contains(*c)) { Some(c) => format!("רכבת קלה · {c}"), None => "רכבת קלה".into() }
        };
        let m = (eta_ms(r["arrival_time"].as_str().or(r["departure_time"].as_str())?)? - now) / 60_000;
        (m >= -1).then(|| (m, short, gtfs_dest(&long), label))
    }).collect();
    Some((st["name"].as_str().unwrap_or("").to_string(), out))
}

#[cfg(test)]
mod tests {
    #[test]
    fn eta_with_offset() {
        // 05:08 in Israel (+02:00) = 03:08 UTC.
        assert_eq!(super::eta_ms("2026-11-15 05:08:00+02:00"), Some(1_794_712_080_000));
    }
    #[test]
    fn stride_bits() {
        assert_eq!(super::iso(1_794_712_080_000), "2026-11-15T03:08:00Z");
        assert_eq!(super::gtfs_dest("הדסה עין כרם-ירושלים<->נווה יעקב - צפון-ירושלים-10"), "נווה יעקב - צפון");
    }
}
