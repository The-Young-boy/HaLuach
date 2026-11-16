// "פודקאסטים" while the page is closed (web/src/cards/podcasts.js is the source of truth; this is its port).
// 2 minutes after start and then every 60 minutes, when a podcasts widget is pinned or the "פודקאסטים" notification
// is on: the followed shows (settings.json cards.podcasts.shows) are fetched from the same URLs the page uses, the
// newest episodes are checked against NetFree (418 = blocked), a toast goes out for a new open episode of a show with
// its "התראה על פרק חדש" on, and the widget summary ({big, sub, rows, at}) is pushed when the page's is older than
// 90 minutes. The data lives in data_dir()/podcasts-seen.json (the page keeps its own in localStorage).
// Toast ids are 'pod-<show key>-<episode id>', checked and recorded in the shared store (crate::notify::seen/mark, 3
// days, the page's alerts too) and in this file's own "_sent" list (longer, so an old episode never comes back).
// Nothing goes out on shabbat or yom tov (crate::quiet_now).
use crate::{data_dir, http, log, widgets};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

const UA: &str = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n";
const MAX_EPS: usize = 20;
const STALE_MS: i64 = 90 * 60_000;
/// The widget marks an episode "new" for this long after it was first seen here (the page uses "since the list was
/// last opened", which only the page knows).
const NEW_MS: i64 = 48 * 3_600_000;

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

pub fn start() {
    std::thread::spawn(|| {
        // The widget updates go through COM (as bg.rs).
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        std::thread::sleep(Duration::from_secs(120));
        loop {
            tick(false);
            std::thread::sleep(Duration::from_secs(60 * 60));
        }
    });
}

#[derive(Clone, Default)]
pub(crate) struct Ep { pub(crate) id: String, title: String, t: i64, url: String, audio: String, tx: bool }
struct Show { key: String, kind: String, src: String, name: String, notify: bool, ch: String, seed: String, asc: bool }
pub(crate) struct Feed { pub(crate) name: String, pub(crate) eps: Vec<Ep> }

fn s(v: &Value) -> String { v.as_str().unwrap_or("").to_string() }

fn shows(c: &Value) -> Vec<Show> {
    c["shows"].as_array().map(|a| a.iter().filter(|x| x["kind"] == "ytp" || x["kind"] == "rss").map(|x| Show {
        key: s(&x["key"]), kind: s(&x["kind"]), src: s(&x["src"]), name: s(&x["name"]), notify: x["notify"].as_bool().unwrap_or(false),
        ch: s(&x["ch"]), seed: s(&x["seed"]), asc: x["asc"].as_bool().unwrap_or(false),
    }).filter(|x| !x.key.is_empty() && !x.src.is_empty()).collect()).unwrap_or_default()
}

/// The widget's "רענון": the feeds now, and the widget's summary whatever its age.
pub fn refresh_now() { tick(true); }

fn tick(force: bool) {
    if crate::quiet_now(0) { return }
    let st = widgets::settings_value();
    let c = &st["cards"]["podcasts"];
    let list = shows(c);
    let notify = st["notify"]["podcasts"].as_bool().unwrap_or(true); // planner.js NOTIFY: podcasts on
    let pinned = widgets::has_kind("podcasts");
    if !pinned && !(notify && list.iter().any(|x| x.notify)) { return }
    if list.is_empty() {
        if pinned { push_if_stale(json!({ "big": "", "sub": "אין פודקאסטים במעקב", "rows": [] }), force); }
        return;
    }
    let mut data = load();
    let now = now_ms();
    let mut chans: HashMap<String, Vec<Ep>> = HashMap::new();
    let mut pending: Vec<Value> = data["_pending"].as_array().cloned().unwrap_or_default();
    for sh in &list {
        match fetch_show(sh, &data[&sh.key], &mut chans) {
            Some(f) => {
                let (entry, added) = merge(&data[&sh.key], f, now);
                data[&sh.key] = entry;
                for id in added { pending.push(json!({ "key": sh.key, "id": id, "at": now })); }
            }
            None => {
                log(&format!("podcasts: {} failed", sh.name));
                if !data[&sh.key].is_object() { data[&sh.key] = json!({ "eps": [] }); }
                data[&sh.key]["failed"] = json!(true);
                data[&sh.key]["tried"] = json!(now);
            }
        }
    }
    check_open(&list, &mut data);

    // The alerts: a new episode of a show with its switch on, once it is known to be open (blocked: "all" = any).
    let blocked = c["blocked"].as_str().unwrap_or("open").to_string();
    let open_mode = c["open"].as_str().unwrap_or("audio").to_string();
    let mut sent: Vec<Value> = data["_sent"].as_array().cloned().unwrap_or_default();
    let mut keep = vec![];
    for p in pending.into_iter().rev().take(60).collect::<Vec<_>>().into_iter().rev() {
        let (key, id) = (s(&p["key"]), s(&p["id"]));
        let Some(sh) = list.iter().find(|x| x.key == key) else { continue };
        let Some(ep) = data[&key]["eps"].as_array().and_then(|a| a.iter().find(|e| e["id"] == id.as_str())).cloned() else { continue };
        if !notify || !sh.notify { continue }
        if blocked != "all" {
            if ep["open"].is_null() { if now - p["at"].as_i64().unwrap_or(0) < 2 * 86_400_000 { keep.push(p); } continue }
            if ep["open"] == false { continue }
        }
        let nid = format!("pod-{key}-{id}");
        if sent.iter().any(|x| x == nid.as_str()) || crate::notify::seen(&nid) { continue }
        let url = ep_url(sh, &ep, &open_mode);
        match crate::notify::toast(&format!("פרק חדש: {}", sh.name), &s(&ep["title"]), &url, "", "") {
            Ok(()) => { log(&format!("podcasts: alert {nid}")); crate::notify::mark(&nid); sent.push(json!(nid)); }
            // not marked: the next check tries again
            Err(e) => { log(&format!("podcasts: toast failed: {e}")); if now - p["at"].as_i64().unwrap_or(0) < 2 * 86_400_000 { keep.push(p); } }
        }
    }
    let n = sent.len();
    data["_sent"] = json!(sent.into_iter().skip(n.saturating_sub(300)).collect::<Vec<_>>());
    data["_pending"] = json!(keep);
    data["_at"] = json!(now);
    save(&data);

    if pinned { push_if_stale(summary(&list, &data, &blocked, now), force); }
}

fn push_if_stale(mut v: Value, force: bool) {
    let at = widgets::current()["podcasts"]["at"].as_i64().unwrap_or(0);
    if !force && now_ms() - at < STALE_MS { return }
    v["at"] = json!(now_ms());
    log("podcasts: widget summary refreshed");
    widgets::push(&json!({ "podcasts": v }).to_string());
}

fn ep_url(sh: &Show, ep: &Value, open: &str) -> String {
    if sh.kind == "ytp" { return format!("https://www.youtube.com/watch?v={}", s(&ep["id"])) }
    let (u, a) = (s(&ep["url"]), s(&ep["audio"]));
    let (x, y) = if open == "page" { (u, a) } else { (a, u) };
    if x.is_empty() { y } else { x }
}

pub(crate) fn cut(t: &str, n: usize) -> String {
    let t = t.trim();
    if t.chars().count() > n { format!("{}…", t.chars().take(n - 1).collect::<String>()) } else { t.to_string() }
}

/// The page's widget(): {big: "N חדשים", sub: "<show>: <episode>", rows: [[show, episode, new]]}.
fn summary(list: &[Show], data: &Value, blocked: &str, now: i64) -> Value {
    let mut all: Vec<(&Show, &Value)> = list.iter().flat_map(|sh| data[&sh.key]["eps"].as_array().into_iter().flatten()
        .filter(|e| blocked == "all" || e["open"] == true).map(move |e| (sh, e))).collect();
    all.sort_by_key(|(_, e)| -e["t"].as_i64().unwrap_or(0));
    let is_new = |e: &Value| e["first"].as_i64().is_some_and(|f| f > 0 && now - f < NEW_MS);
    let n = all.iter().filter(|(_, e)| is_new(e)).count();
    json!({
        "big": if n > 0 { format!("{n} חדשים") } else { String::new() },
        "sub": all.first().map(|(sh, e)| cut(&format!("{}: {}", sh.name, s(&e["title"])), 60)).unwrap_or_else(|| "אין פרקים עדיין".into()),
        "rows": all.iter().take(4).map(|(sh, e)| json!([sh.name, cut(&s(&e["title"]), 40), is_new(e)])).collect::<Vec<_>>(),
    })
}

// ---------- the data file ----------
fn path() -> std::path::PathBuf { data_dir().join("podcasts-seen.json") }
fn load() -> Value {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(|v| v.is_object()).unwrap_or(json!({}))
}
fn save(v: &Value) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(path(), v.to_string());
}

/// The page's merge(): new = an id not seen before and newer than every known episode; the first fetch marks nothing.
pub(crate) fn merge(old: &Value, fresh: Feed, now: i64) -> (Value, Vec<String>) {
    let old_eps: Vec<Value> = old["eps"].as_array().cloned().unwrap_or_default();
    let mut prev: BTreeMap<String, Value> = old_eps.iter().map(|e| (s(&e["id"]), e.clone())).collect();
    let max_old = old_eps.iter().filter_map(|e| e["t"].as_i64()).max().unwrap_or(0).max(0);
    let first_known = fresh.eps.iter().position(|e| prev.contains_key(&e.id));
    let mut added = vec![];
    let mut eps: Vec<Value> = fresh.eps.iter().enumerate().map(|(i, e)| {
        if let Some(mut o) = prev.remove(&e.id) {
            if !e.title.is_empty() { o["title"] = json!(e.title); }
            if !e.url.is_empty() { o["url"] = json!(e.url); }
            if !e.audio.is_empty() { o["audio"] = json!(e.audio); }
            if e.tx || o["t"].as_i64().unwrap_or(0) == 0 {
                let t = if e.t != 0 { e.t } else { o["t"].as_i64().unwrap_or(0) };
                o["t"] = json!(t);
                o["tx"] = json!(e.tx);
            }
            return o;
        }
        let t = if e.t != 0 { e.t } else if !old_eps.is_empty() && first_known.is_some_and(|k| i < k) { now - i as i64 } else { 0 };
        let new = !old_eps.is_empty() && t != 0 && t > max_old - 60_000;
        if new { added.push(e.id.clone()); }
        json!({ "id": e.id, "title": e.title, "t": t, "url": e.url, "audio": e.audio, "tx": e.tx, "first": if new { now } else { 0 } })
    }).collect();
    eps.extend(prev.into_values());
    eps.sort_by_key(|e| -e["t"].as_i64().unwrap_or(0));
    eps.truncate(MAX_EPS);
    let added: Vec<String> = added.into_iter().filter(|id| eps.iter().any(|e| e["id"] == id.as_str())).collect();
    let name = if fresh.name.is_empty() { s(&old["name"]) } else { fresh.name };
    (json!({ "name": name, "eps": eps, "at": now, "tried": now, "failed": false }), added)
}

// ---------- NetFree: 418 = blocked; any other answer from the source = open; no answer = unknown ----------
pub(crate) fn ep_open(kind: &str, ep: &Value, head_ok: &mut bool, gets: &mut u32) -> Option<bool> {
    let yt = kind == "ytp";
    let url = if yt { format!("https://www.youtube.com/watch?v={}", s(&ep["id"])) } else { s(&ep["audio"]) };
    if url.is_empty() { return None }
    let get = yt && !*head_ok;
    if get { *gets += 1; if *gets > 4 { return None } }
    let r = http::fetch(if get { "GET" } else { "HEAD" }, &url, UA, b"")?;
    match r.status {
        418 => Some(false),
        405 if yt && *head_ok => { *head_ok = false; ep_open(kind, ep, head_ok, gets) }
        200..=399 => Some(true),
        400..=499 => Some(true),
        _ => None,
    }
}
/// The newest unchecked episodes (and blocked ones again), at most 20 per run.
fn check_open(list: &[Show], data: &mut Value) {
    let mut todo: Vec<(String, String, usize, bool, i64)> = vec![];
    for sh in list {
        for (i, ep) in data[&sh.key]["eps"].as_array().into_iter().flatten().take(10).enumerate() {
            if ep["open"].is_null() || ep["open"] == false { todo.push((sh.key.clone(), sh.kind.clone(), i, ep["open"] == false, ep["t"].as_i64().unwrap_or(0))); }
        }
    }
    todo.sort_by_key(|x| (x.3, -x.4));
    let (mut head_ok, mut gets) = (true, 0);
    for (key, kind, i, _, _) in todo.into_iter().take(20) {
        let ep = data[&key]["eps"][i].clone();
        if let Some(open) = ep_open(&kind, &ep, &mut head_ok, &mut gets) {
            data[&key]["eps"][i]["open"] = json!(open);
            data[&key]["eps"][i]["checked"] = json!(now_ms());
        }
    }
}

// ---------- fetching (the page's URLs only: youtube.com and the shows' own RSS feeds) ----------
pub(crate) fn get_text(url: &str) -> Option<String> {
    let r = http::fetch("GET", url, UA, b"")?;
    if r.status >= 400 { return None }
    Some(String::from_utf8_lossy(&r.body).into_owned())
}

fn sort_cap(mut eps: Vec<Ep>) -> Vec<Ep> {
    eps.sort_by_key(|e| -e.t);
    eps.truncate(MAX_EPS);
    eps
}

fn fetch_show(sh: &Show, old: &Value, chans: &mut HashMap<String, Vec<Ep>>) -> Option<Feed> {
    if sh.kind == "ytp" { return fetch_playlist(sh, old, chans) }
    let f = parse_feed(&get_text(&sh.src)?)?;
    Some(Feed { name: f.name, eps: sort_cap(f.eps) })
}

/// Newest first: the playlist order, turned when it is oldest first. Known dates decide; else the show's hint.
fn newest_first(mut list: Vec<Ep>, known: &HashMap<String, i64>, asc_hint: bool) -> Vec<Ep> {
    let dated: Vec<i64> = list.iter().map(|e| known.get(&e.id).copied().filter(|t| *t != 0).unwrap_or(e.t)).filter(|t| *t != 0).collect();
    let asc = if dated.len() > 1 { dated[0] < dated[dated.len() - 1] } else { asc_hint };
    if asc { list.reverse(); }
    list
}

/// The page's fetchPlaylist(): the RSS (works outside NetFree), the watch page of a known open episode with &list=
/// (its side panel), the channel's /videos page filtered by the podcast's name, then the playlist page.
fn fetch_playlist(sh: &Show, old: &Value, chans: &mut HashMap<String, Vec<Ep>>) -> Option<Feed> {
    let id = &sh.src;
    let old_eps: Vec<Value> = old["eps"].as_array().cloned().unwrap_or_default();
    let known: HashMap<String, i64> = old_eps.iter().map(|e| (s(&e["id"]), e["t"].as_i64().unwrap_or(0))).collect();
    if let Some(f) = get_text(&format!("https://www.youtube.com/feeds/videos.xml?playlist_id={id}&r={}", now_ms() % 1_000_000)).and_then(|x| parse_feed(&x)) {
        let asc = f.eps.len() > 1 && f.eps[0].t < f.eps[f.eps.len() - 1].t;
        if !f.eps.is_empty() && !(asc && f.eps.len() >= 15) { return Some(Feed { name: f.name, eps: sort_cap(f.eps) }) }
    }
    let vids: Vec<Ep> = if sh.ch.is_empty() { vec![] } else {
        chans.entry(sh.ch.clone()).or_insert_with(|| {
            get_text(&format!("https://www.youtube.com/channel/{}/videos?hl=iw&gl=IL", sh.ch)).and_then(|h| parse_yt_list(&h, now_ms())).map(|f| f.eps).unwrap_or_default()
        }).clone()
    };
    let date_of: HashMap<String, i64> = vids.iter().filter(|v| v.t != 0).map(|v| (v.id.clone(), v.t)).collect();
    let dated = |mut e: Ep| { if e.t == 0 { e.t = date_of.get(&e.id).copied().unwrap_or(0); } e };
    let mut seeds: Vec<String> = vec![];
    for v in old_eps.iter().filter(|e| e["open"] != false).map(|e| s(&e["id"])).chain(std::iter::once(sh.seed.clone())) {
        if !v.is_empty() && !seeds.contains(&v) { seeds.push(v); }
    }
    for v in seeds.iter().take(3) {
        if let Some(p) = get_text(&format!("https://www.youtube.com/watch?v={v}&list={id}&hl=iw&gl=IL")).and_then(|h| parse_yt_panel(&h)) {
            if !p.eps.is_empty() {
                let mut eps = newest_first(p.eps.into_iter().map(dated).collect(), &known, sh.asc);
                eps.truncate(MAX_EPS);
                return Some(Feed { name: p.name, eps });
            }
        }
    }
    let key = title_key(&sh.name);
    if key.chars().count() > 1 {
        let mine: Vec<Ep> = vids.iter().filter(|v| known.contains_key(&v.id) || no_niqqud(&v.title).contains(&key)).take(MAX_EPS).cloned().collect();
        if !mine.is_empty() { return Some(Feed { name: String::new(), eps: mine }) }
    }
    let p = parse_yt_list(&get_text(&format!("https://www.youtube.com/playlist?list={id}&hl=iw&gl=IL"))?, now_ms())?;
    let mut eps = newest_first(p.eps.into_iter().map(dated).collect(), &known, sh.asc);
    eps.truncate(MAX_EPS);
    Some(Feed { name: p.name, eps })
}

/// Without niqqud, cantillation and quote marks (U+0591..U+05C7, " ' ׳ ״).
fn no_niqqud(t: &str) -> String { t.chars().filter(|c| !('\u{0591}'..='\u{05C7}').contains(c) && !matches!(c, '"' | '\'' | '׳' | '״')).collect() }
/// The first words of a podcast's name ("מורשת | בהגשת..." -> "מורשת").
fn title_key(name: &str) -> String {
    let mut cut_at = name.len();
    if let Some(i) = name.find('|') { cut_at = i; }
    let ch: Vec<(usize, char)> = name.char_indices().collect();
    for w in ch.windows(3) {
        if w[0].1.is_whitespace() && matches!(w[1].1, '-' | '–' | ':') && w[2].1.is_whitespace() { cut_at = cut_at.min(w[0].0); break }
    }
    no_niqqud(&name[..cut_at]).trim().to_string()
}

// ---------- RSS 2.0 / Atom ----------
fn decode(x: &str) -> String {
    let x = x.trim();
    let x = x.strip_prefix("<![CDATA[").and_then(|y| y.strip_suffix("]]>")).map(String::from).unwrap_or_else(|| entities(x));
    x.trim().to_string()
}
fn entities(x: &str) -> String {
    let mut out = String::with_capacity(x.len());
    let mut rest = x;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // ';' within the first 12 bytes; never slice at a byte index (Hebrew right after '&' is multi-byte)
        let Some(j) = rest.bytes().take(12).position(|b| b == b';') else { out.push('&'); rest = &rest[1..]; continue };
        let e = &rest[1..j];
        let c = match e {
            "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" => Some('\''),
            _ if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            _ if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match c { Some(c) => { out.push(c); rest = &rest[j + 1..]; } None => { out.push('&'); rest = &rest[1..]; } }
    }
    out.push_str(rest);
    out
}
/// The first direct <tag ...>text</tag> (or <tag .../>) in `xml`: (attributes, inner text).
fn tag<'a>(xml: &'a str, name: &str) -> Option<(&'a str, &'a str)> {
    let open = format!("<{name}");
    let mut from = 0;
    while let Some(i) = xml[from..].find(&open) {
        let at = from + i + open.len();
        let next = xml[at..].chars().next()?;
        if !(next.is_whitespace() || next == '>' || next == '/') { from = at; continue }
        let gt = at + xml[at..].find('>')?;
        let attrs = &xml[at..gt];
        if attrs.ends_with('/') { return Some((attrs, "")) }
        let close = format!("</{name}>");
        let end = gt + 1 + xml[gt + 1..].find(&close)?;
        return Some((attrs, &xml[gt + 1..end]));
    }
    None
}
fn attr(attrs: &str, name: &str) -> String {
    for q in ['"', '\''] {
        let k = format!("{name}={q}");
        let mut from = 0;
        while let Some(i) = attrs[from..].find(&k) {
            let p = from + i;
            if p == 0 || attrs[..p].ends_with(char::is_whitespace) {
                let v = &attrs[p + k.len()..];
                return entities(&v[..v.find(q).unwrap_or(v.len())]);
            }
            from = p + k.len();
        }
    }
    String::new()
}
fn text(xml: &str, name: &str) -> String { tag(xml, name).map(|(_, t)| decode(t)).unwrap_or_default() }

pub(crate) fn parse_feed(xml: &str) -> Option<Feed> {
    let first = [xml.find("<item>"), xml.find("<item "), xml.find("<entry>"), xml.find("<entry ")].into_iter().flatten().min().unwrap_or(xml.len());
    let name = text(&xml[..first], "title");
    let mut eps = vec![];
    for (open, close) in [("<item", "</item>"), ("<entry", "</entry>")] {
        let mut rest = &xml[first..];
        while let Some(i) = rest.find(open) {
            let after = &rest[i + open.len()..];
            if !after.starts_with(['>', ' ', '\t', '\r', '\n']) { rest = after; continue }
            let Some(j) = after.find(close) else { break };
            let it = &after[..j];
            rest = &after[j + close.len()..];
            let link = tag(it, "link").map(|(a, t)| { let h = attr(a, "href"); if h.is_empty() { decode(t) } else { h } }).unwrap_or_default();
            let audio = tag(it, "enclosure").map(|(a, _)| attr(a, "url")).unwrap_or_default();
            let title = text(it, "title");
            let t = [text(it, "pubDate"), text(it, "published"), text(it, "updated")].into_iter().find(|x| !x.is_empty()).map(|d| parse_date(&d)).unwrap_or(0);
            let id = [text(it, "yt:videoId"), text(it, "guid"), text(it, "id"), link.clone(), audio.clone(), title.clone()].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
            if !id.is_empty() { eps.push(Ep { id, title, t, url: link, audio, tx: true }); }
        }
    }
    if eps.is_empty() && name.is_empty() { return None }
    Some(Feed { name, eps })
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}
fn zone(z: &str) -> i64 {
    let z = z.trim();
    match z {
        "" | "Z" | "GMT" | "UT" | "UTC" => 0,
        "EST" => -300, "EDT" => -240, "CST" => -360, "CDT" => -300, "MST" => -420, "MDT" => -360, "PST" => -480, "PDT" => -420,
        _ => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let d: String = z.chars().filter(|c| c.is_ascii_digit()).collect();
            if d.len() < 4 { return 0 }
            sign * (d[..2].parse::<i64>().unwrap_or(0) * 60 + d[2..4].parse::<i64>().unwrap_or(0))
        }
    }
}
/// RFC 822 ("Sun, 15 Nov 2026 10:00:00 +0200") or ISO 8601 ("2026-11-15T10:00:00+00:00") -> ms (0 = unknown).
fn parse_date(d: &str) -> i64 {
    let d = d.trim();
    let hms = |t: &str| -> Option<i64> {
        let p: Vec<i64> = t.split(':').map(|x| x.split('.').next().unwrap_or("").parse().ok()).collect::<Option<_>>()?;
        Some(p.first()? * 3600 + p.get(1).copied().unwrap_or(0) * 60 + p.get(2).copied().unwrap_or(0))
    };
    if d.len() >= 10 && d.is_char_boundary(10) && d[..10].is_ascii() && d.as_bytes()[4] == b'-' {
        let (y, m, dd) = (d[..4].parse().unwrap_or(0), d[5..7].parse().unwrap_or(0), d[8..10].parse().unwrap_or(0));
        if y == 0 { return 0 }
        let rest = d[10..].trim_start_matches(['T', ' ']);
        let zi = rest.find(['Z', '+', '-']).unwrap_or(rest.len());
        let secs = if rest.is_empty() { 0 } else { hms(&rest[..zi]).unwrap_or(0) };
        return (days_from_civil(y, m, dd) * 86_400 + secs - zone(&rest[zi..]) * 60) * 1000;
    }
    const MON: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let w: Vec<&str> = d.split(|c: char| c.is_whitespace() || c == ',').filter(|x| !x.is_empty()).collect();
    let w = if w.first().is_some_and(|x| x.chars().all(|c| c.is_alphabetic())) { &w[1..] } else { &w[..] };
    if w.len() < 4 { return 0 }
    let Some(m) = MON.iter().position(|x| w[1].to_ascii_lowercase().starts_with(x)) else { return 0 };
    let (Ok(dd), Ok(mut y)) = (w[0].parse::<i64>(), w[2].parse::<i64>()) else { return 0 };
    if y < 100 { y += 2000; }
    let secs = hms(w[3]).unwrap_or(0);
    (days_from_civil(y, m as i64 + 1, dd) * 86_400 + secs - zone(w.get(4).copied().unwrap_or("")) * 60) * 1000
}

// ---------- YouTube pages (ytInitialData) ----------
/// "לפני 3 ימים", "לפני יומיים" -> ms since then (0 = not a past time).
fn parse_ago(text: &str) -> i64 {
    let Some(i) = text.find("לפני") else { return 0 };
    let s = text[i + "לפני".len()..].trim_start();
    if s.is_empty() { return 0 }
    let has = |w: &[&str]| w.iter().any(|x| s.contains(x));
    let unit: i64 = if has(&["שניות", "שנייה", "שניה"]) { 1_000 } else if has(&["דק"]) { 60_000 } else if has(&["שע"]) { 3_600_000 }
        else if has(&["יום", "ימים", "יומיים"]) { 86_400_000 } else if has(&["שבוע"]) { 604_800_000 } else if has(&["חודש"]) { 2_592_000_000 }
        else if has(&["שנה", "שנים", "שנתיים"]) { 31_536_000_000 } else { 0 };
    if unit == 0 { return 0 }
    let digits: String = s.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    let n = digits.parse::<i64>().ok().unwrap_or_else(|| {
        let dual = s.split(|c: char| c.is_whitespace() || c == '(').any(|w| w.ends_with("יים"));
        if dual { 2 } else { 1 }
    });
    n * unit
}

fn initial_data(html: &str) -> Option<Value> {
    let k = "var ytInitialData = ";
    let i = html.find(k)? + k.len();
    let j = i + html[i..].find("};</script>")? + 1;
    serde_json::from_str(&html[i..j]).ok()
}
fn runs(v: &Value) -> String { v["runs"].as_array().map(|a| a.iter().map(|r| s(&r["text"])).collect()).unwrap_or_default() }

fn walk_list(o: &Value, now: i64, eps: &mut Vec<Ep>) {
    if eps.len() >= 200 { return }
    match o {
        Value::Object(m) => {
            let l = &o["lockupViewModel"];
            if l["contentId"].is_string() && s(&l["contentType"]).contains("VIDEO") {
                let md = &l["metadata"]["lockupMetadataViewModel"];
                let ago = md["metadata"]["contentMetadataViewModel"]["metadataRows"].as_array().into_iter().flatten()
                    .flat_map(|r| r["metadataParts"].as_array().cloned().unwrap_or_default())
                    .map(|p| parse_ago(&p["accessibilityLabel"].as_str().map(String::from).unwrap_or_else(|| s(&p["text"]["content"]))))
                    .find(|x| *x != 0).unwrap_or(0);
                eps.push(Ep { id: s(&l["contentId"]), title: s(&md["title"]["content"]), t: if ago != 0 { now - ago } else { 0 }, ..Default::default() });
                return;
            }
            let v = if o["playlistVideoRenderer"].is_object() { &o["playlistVideoRenderer"] } else { &o["videoRenderer"] };
            if v["videoId"].is_string() {
                let pt = v["publishedTimeText"]["simpleText"].as_str().map(String::from).unwrap_or_else(|| runs(&v["videoInfo"]));
                let ago = parse_ago(&pt);
                let t = runs(&v["title"]);
                eps.push(Ep { id: s(&v["videoId"]), title: if t.is_empty() { s(&v["title"]["simpleText"]) } else { t }, t: if ago != 0 { now - ago } else { 0 }, ..Default::default() });
                return;
            }
            for x in m.values() { walk_list(x, now, eps); }
        }
        Value::Array(a) => for x in a { walk_list(x, now, eps); },
        _ => {}
    }
}
/// A playlist or channel /videos page (hl=iw) -> its videos in the page's order.
fn parse_yt_list(html: &str, now: i64) -> Option<Feed> {
    let d = initial_data(html)?;
    let mut eps = vec![];
    walk_list(&d, now, &mut eps);
    let name = d["metadata"]["playlistMetadataRenderer"]["title"].as_str().map(String::from).unwrap_or_else(|| s(&d["header"]["pageHeaderRenderer"]["pageTitle"]));
    Some(Feed { name, eps })
}
/// A watch page opened with &list= -> the playlist from its side panel, in playlist order.
fn parse_yt_panel(html: &str) -> Option<Feed> {
    let d = initial_data(html)?;
    let pl = &d["contents"]["twoColumnWatchNextResults"]["playlist"]["playlist"];
    let items = pl["contents"].as_array()?;
    let mut seen = HashSet::new();
    let eps = items.iter().map(|c| &c["playlistPanelVideoRenderer"]).filter(|v| v["videoId"].is_string() && seen.insert(s(&v["videoId"])))
        .map(|v| Ep { id: s(&v["videoId"]), title: v["title"]["simpleText"].as_str().map(String::from).unwrap_or_else(|| runs(&v["title"])), ..Default::default() }).collect();
    Some(Feed { name: s(&pl["title"]), eps })
}
