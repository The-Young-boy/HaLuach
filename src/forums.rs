// Forum notifications (SPEC "התראות מפורומים", research/forums.md). Per forum the user picks how to connect:
//  - "window": the forum's login page in an Edge window with a profile of our own and the DevTools port on; the
//    login cookie (NodeBB express.sid, XenForo xf_user/xf_session) is read over DevTools once the forum says
//    "signed in", and Edge is closed (as HaFeed's login.rs);
//  - "creds": a username and password typed in the card's settings. We log in by ourselves (NodeBB: /api/config
//    csrf then POST /login; XenForo: _xfToken from /login/ then POST /login/login) and again when the session ends.
// Secrets (cookies, username, password) are kept only here, in forums.dat, encrypted with DPAPI (this Windows user).
// They go only to that forum, over https, and are never logged. The rest (counts, last items) is forums.json.
use crate::{data_dir, http, log};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub struct Forum {
    pub id: &'static str,
    pub name: &'static str,
    pub base: &'static str,
    pub xf: bool,
}
const fn nb(id: &'static str, name: &'static str, base: &'static str) -> Forum { Forum { id, name, base, xf: false } }
const fn xf(id: &'static str, name: &'static str, base: &'static str) -> Forum { Forum { id, name, base, xf: true } }
/// research/forums.md: open in NetFree (Pi, 14.11.26). Left out: בחדרי חרדים (blocked), forum-office (no answer,
/// Cloudflare), מורשת מרן (account/alerts 404: not XenForo).
pub const FORUMS: &[Forum] = &[
    nb("mitmachim", "מתמחים טופ", "https://mitmachim.top"),
    nb("merchavim", "מרחבים", "https://merchavim.space"),
    nb("freeivr", "ימות המשיח", "https://f2.freeivr.co.il"),
    nb("netfree", "פורום נטפרי", "https://forum.netfree.link"),
    nb("rechavim", "רכבים זה לזה", "https://rechavimzelaze.ovh"),
    nb("safera", "סייפר", "https://forum.safera.co.il"),
    nb("miktzav", "מקצב", "https://miktzav.com"),
    nb("hamusicay", "המוזיקאי", "https://hamusicay.com/forum"),
    nb("otzaria", "אוצריא", "https://otzaria.org/forum"),
    nb("goodlink", "Good-לינק", "https://good-link.org"),
    nb("benakel", "בנקל", "https://forum.benakel.org"),
    nb("diy", "ידיים טובות", "https://diy-il.forum"),
    nb("bina", "בינה טופ", "https://bina.top"),
    nb("bnebrak", "פורום בני ברק", "https://bnebrak.com"),
    xf("prog", "פרוג", "https://www.prog.co.il"),
    xf("tora", "פורום לתורה", "https://tora-forum.co.il"),
    xf("otzar", "אוצר התורה", "https://forum-otzar-hatorah.co.il"),
    xf("solidit", "הסולידית", "https://www.hasolidit.com/kehila"),
];
fn forum(id: &str) -> Option<&'static Forum> { FORUMS.iter().find(|f| f.id == id) }
impl Forum {
    fn host(&self) -> &str { self.base.trim_start_matches("https://").split('/').next().unwrap_or("") }
    fn origin(&self) -> String { format!("https://{}", self.host()) }
    fn path(&self) -> &str { let r = self.base.trim_start_matches("https://"); r.find('/').map_or("", |i| &r[i..]) }
    /// A link from the forum (absolute, root-relative with or without the forum's sub-path) as a full https url.
    fn link(&self, p: &str) -> String {
        if p.starts_with("https://") { return p.to_string() }
        if p.is_empty() { return self.base.to_string() }
        let p = if p.starts_with('/') { p.to_string() } else { format!("/{p}") };
        let sub = self.path();
        if !sub.is_empty() && (p == sub || p.starts_with(&format!("{sub}/"))) { format!("{}{p}", self.origin()) } else { format!("{}{p}", self.base) }
    }
}

// ---------- DPAPI (as HaFeed's login.rs) ----------
#[repr(C)]
struct Blob { len: u32, data: *mut u8 }
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(input: *const Blob, desc: *const u16, entropy: *const Blob, reserved: *const core::ffi::c_void, prompt: *const core::ffi::c_void, flags: u32, out: *mut Blob) -> windows_core::BOOL;
    fn CryptUnprotectData(input: *const Blob, desc: *mut *mut u16, entropy: *const Blob, reserved: *const core::ffi::c_void, prompt: *const core::ffi::c_void, flags: u32, out: *mut Blob) -> windows_core::BOOL;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(p: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
}
pub(crate) fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    unsafe {
        let input = Blob { len: data.len() as u32, data: data.as_ptr() as *mut u8 };
        let mut out = Blob { len: 0, data: core::ptr::null_mut() };
        // 1 = CRYPTPROTECT_UI_FORBIDDEN; no LOCAL_MACHINE flag = only this Windows user
        let ok = if protect {
            CryptProtectData(&input, core::ptr::null(), core::ptr::null(), core::ptr::null(), core::ptr::null(), 1, &mut out)
        } else {
            CryptUnprotectData(&input, core::ptr::null_mut(), core::ptr::null(), core::ptr::null(), core::ptr::null(), 1, &mut out)
        };
        if !ok.as_bool() { return None }
        let v = std::slice::from_raw_parts(out.data, out.len as usize).to_vec();
        LocalFree(out.data as _);
        Some(v)
    }
}

// ---------- the secrets: id -> {"m": "window"|"creds", "c": cookie header, "u": user, "p": password} ----------
static SECRETS: Mutex<Option<BTreeMap<String, Value>>> = Mutex::new(None);
fn with_secrets<R>(f: impl FnOnce(&mut BTreeMap<String, Value>) -> R) -> R {
    let mut g = SECRETS.lock().unwrap();
    let m = g.get_or_insert_with(|| {
        std::fs::read(data_dir().join("forums.dat")).ok().and_then(|b| dpapi(&b, false)).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    });
    f(m)
}
fn save_secrets(m: &BTreeMap<String, Value>) {
    let Ok(text) = serde_json::to_vec(m) else { return };
    if let Some(enc) = dpapi(&text, true) {
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(data_dir().join("forums.dat"), enc);
    }
}
fn secret(id: &str) -> Option<Value> { with_secrets(|m| m.get(id).cloned()) }
fn set_cookie_of(id: &str, cookie: &str) {
    with_secrets(|m| if let Some(s) = m.get_mut(id) { if s["c"] != cookie { s["c"] = json!(cookie); save_secrets(m); } });
}

// ---------- the state the page sees: id -> {unread, chats, items, seen, etag, at, err, primed, stop, n} ----------
static STATE: Mutex<Option<BTreeMap<String, Value>>> = Mutex::new(None);
fn with_state<R>(f: impl FnOnce(&mut BTreeMap<String, Value>) -> R) -> R {
    let mut g = STATE.lock().unwrap();
    let m = g.get_or_insert_with(|| std::fs::read(data_dir().join("forums.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default());
    f(m)
}
fn save_state(m: &BTreeMap<String, Value>) {
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(data_dir().join("forums.json"), serde_json::to_vec(m).unwrap_or_default());
}

#[derive(Clone, PartialEq)]
enum Run { Pending, Failed(String) }
static RUNS: Mutex<BTreeMap<String, Run>> = Mutex::new(BTreeMap::new());
static DUE: Mutex<BTreeMap<String, Instant>> = Mutex::new(BTreeMap::new()); // id -> next poll

/// The card's settings (cards.forums in settings.json): interval in minutes (default 5), notify per forum (default on).
fn card_settings() -> Value {
    let v: Value = std::fs::read(data_dir().join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    v["cards"]["forums"].clone()
}
fn interval() -> Duration { Duration::from_secs(card_settings()["interval"].as_u64().unwrap_or(5).clamp(1, 240) * 60) }
fn notify_on(id: &str) -> bool { card_settings()["notify"][id].as_bool().unwrap_or(true) }

// ---------- cookies and headers ----------
fn header<'a>(raw: &'a str, name: &str) -> impl Iterator<Item = &'a str> + use<'a> {
    let n = format!("{name}:");
    raw.lines().filter_map(move |l| l.get(..n.len()).filter(|h| h.eq_ignore_ascii_case(&n)).map(|_| l[n.len()..].trim()))
}
/// The Cookie header after a reply's Set-Cookie lines (a cookie set empty or to expire is dropped).
pub fn merge_cookies(cookie: &str, raw: &str) -> String {
    let mut m: Vec<(String, String)> = cookie.split(';').filter_map(|p| p.trim().split_once('=')).map(|(n, v)| (n.to_string(), v.to_string())).collect();
    for sc in header(raw, "set-cookie") {
        let Some((n, v)) = sc.split(';').next().and_then(|p| p.split_once('=')) else { continue };
        let (n, v) = (n.trim(), v.trim());
        let l = sc.to_ascii_lowercase();
        let gone = v.is_empty() || v == "deleted" || l.contains("max-age=0") || l.contains("expires=thu, 01 jan 1970") || l.contains("max-age=-");
        m.retain(|(k, _)| k != n);
        if !gone { m.push((n.to_string(), v.to_string())); }
    }
    m.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ")
}
fn get(url: &str, cookie: &str, extra: &str) -> Option<(http::Reply, String)> {
    let mut h = String::from("Accept: application/json, text/html;q=0.9\r\n");
    if !cookie.is_empty() { h += &format!("Cookie: {cookie}\r\n"); }
    h += extra;
    http::fetch_plain("GET", url, &h, b"")
}
fn enc(s: &str) -> String {
    s.bytes().map(|b| match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(), _ => format!("%{b:02X}") }).collect()
}
fn body_str(r: &http::Reply) -> String { String::from_utf8_lossy(&r.body).into_owned() }

// ---------- text ----------
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out += &rest[..i];
        rest = &rest[i..];
        // ';' within the first 12 bytes; never slice at a byte index (Hebrew right after '&' is multi-byte)
        let Some(end) = rest.bytes().take(12).position(|b| b == b';') else { out.push('&'); rest = &rest[1..]; continue };
        let ent = &rest[1..end];
        let ch = match ent {
            "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" => Some('\''), "nbsp" => Some(' '),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch { Some(c) => { out.push(c); rest = &rest[end + 1..]; } None => { out.push('&'); rest = &rest[1..]; } }
    }
    out + rest
}
/// HTML to one line of plain text.
pub fn plain(html: &str) -> String {
    // Inline tags (a, strong, span) join their text; block tags and line breaks are a space.
    let mut out = String::with_capacity(html.len());
    let mut tag: Option<String> = None;
    for c in html.chars() {
        match (&mut tag, c) {
            (None, '<') => tag = Some(String::new()),
            (Some(t), '>') => {
                let name: String = t.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
                if matches!(name.as_str(), "br" | "div" | "p" | "li" | "ul" | "ol" | "tr" | "td" | "time" | "h1" | "h2" | "h3" | "h4") { out.push(' '); }
                tag = None;
            }
            (Some(t), c) => t.push(c),
            (None, c) => out.push(c),
        }
    }
    decode_entities(&out).split_whitespace().collect::<Vec<_>>().join(" ").replace(" .", ".").replace(" ,", ",")
}
/// NodeBB keeps some notification texts as translation keys: "[[notifications:user-posted-to, <strong>A</strong>, <strong>T</strong>]]".
pub fn nodebb_text(s: &str) -> String {
    let t = s.trim();
    let Some(inner) = t.strip_prefix("[[").and_then(|x| x.strip_suffix("]]")) else { return plain(t) };
    // nested tokens first ([[global:guest]] and the like)
    let inner = inner.replace("[[global:guest]]", "אורח").replace("[[global:former-user]]", "משתמש לשעבר");
    let mut parts = inner.split(',').map(|p| plain(p).trim().to_string());
    let key = parts.next().unwrap_or_default();
    let a: Vec<String> = parts.collect();
    let x = |i: usize| a.get(i).cloned().unwrap_or_default();
    let key = key.rsplit(':').next().unwrap_or("").to_string();
    let k = key.as_str();
    let txt = if k.starts_with("user-posted-to") || k.starts_with("user-replied-to") { format!("{} הגיב/ה ב{}", x(0), x(x_last(&a))) }
        else if k.starts_with("user-posted-topic") { format!("{} פתח/ה נושא: {}", x(0), x(x_last(&a))) }
        else if k.starts_with("user-mentioned-you") || k.starts_with("user-mentioned") { format!("{} הזכיר/ה אותך ב{}", x(0), x(x_last(&a))) }
        else if k.starts_with("upvoted-your-post") { format!("{} הצביע/ה לפוסט שלך ב{}", x(0), x(x_last(&a))) }
        else if k.starts_with("bookmarked-your-post") { format!("{} שמר/ה את הפוסט שלך ב{}", x(0), x(x_last(&a))) }
        else if k.starts_with("user-started-following-you") { format!("{} עוקב/ת אחריך", x(0)) }
        else if k.starts_with("new-message-from") || k.starts_with("new-chat") || k.contains("chat") { format!("הודעה חדשה מ{}", x(0)) }
        else if k.starts_with("user-flagged") { format!("{} דיווח/ה על פוסט ב{}", x(0), x(x_last(&a))) }
        else if k.starts_with("moved-your-post") || k.starts_with("moved-your-topic") { format!("{} העביר/ה את הפוסט שלך ל{}", x(0), x(x_last(&a))) }
        else if k.starts_with("user-edited-post") { format!("{} ערך/ה פוסט ב{}", x(0), x(x_last(&a))) }
        else { a.iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ") };
    let txt = txt.split_whitespace().collect::<Vec<_>>().join(" ");
    if txt.is_empty() { "התראה חדשה".into() } else { txt }
}
fn x_last(a: &[String]) -> usize { if a.len() >= 2 { a.len() - 1 } else { 1 } }

// ---------- parsing ----------
/// /api/notifications -> items {id, text, url, at, unread}, newest first.
pub fn parse_nodebb(f: &Forum, v: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = v["notifications"].as_array().into_iter().flatten().map(|n| {
        let nid = n["nid"].as_str().map(str::to_string).unwrap_or_else(|| n["nid"].to_string());
        let path = n["path"].as_str().unwrap_or("");
        let pid = n["pid"].as_i64().map(|p| p.to_string()).or_else(|| nid.split("pid:").nth(1).map(|r| r.chars().take_while(char::is_ascii_digit).collect::<String>()).filter(|p| !p.is_empty()));
        let url = if !path.is_empty() { f.link(path) } else if let Some(p) = pid { f.link(&format!("/post/{p}")) } else { f.link("/notifications") };
        let text = nodebb_text(n["bodyShort"].as_str().or(n["bodyLong"].as_str()).unwrap_or(""));
        let at = n["datetime"].as_i64().unwrap_or(0);
        json!({ "id": nid, "text": text, "url": url, "at": at, "unread": !n["read"].as_bool().unwrap_or(false) })
    }).collect();
    out.sort_by_key(|i| std::cmp::Reverse(i["at"].as_i64().unwrap_or(0)));
    out
}
fn num(v: &Value) -> Option<i64> { v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())) }
/// A XenForo JSON reply's visitor counts: (alerts, conversations). None = not signed in.
pub fn xf_counts(body: &str) -> Option<(i64, i64)> {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        let vis = &v["visitor"];
        if vis.is_null() { return None }
        let alerts = num(&vis["alerts_unviewed"]).or(num(&vis["alerts_unread"])).unwrap_or(0);
        return Some((alerts, num(&vis["conversations_unread"]).unwrap_or(0)));
    }
    // an HTML page: the navigation badges
    let badge = |cls: &str| -> Option<i64> {
        let i = body.find(cls)?;
        let tag_end = i + body[i..].find('>')?;
        let tag_start = body[..i].rfind('<')?;
        let tag = &body[tag_start..tag_end];
        let b = tag.find("data-badge=\"")? + 12;
        tag[b..].split('"').next()?.trim().parse().ok()
    };
    if !body.contains("js-badge--alerts") { return None }
    Some((badge("js-badge--alerts").unwrap_or(0), badge("js-badge--conversations").unwrap_or(0)))
}
/// The alert rows in XenForo's alerts HTML (the popup's html.content or the alerts page).
pub fn parse_xf_alerts(f: &Forum, html: &str) -> Vec<Value> {
    let key = "data-alert-id=\"";
    let marks: Vec<usize> = html.match_indices(key).map(|(i, _)| i).collect();
    let mut out = Vec::new();
    for (k, &pos) in marks.iter().enumerate() {
        let Some(tag_start) = html[..pos].rfind('<') else { continue };
        let Some(te) = html[pos..].find('>') else { continue };
        let tag_end = pos + te;
        let tag = &html[tag_start..tag_end];
        let id: String = html[pos + key.len()..].chars().take_while(|c| *c != '"').collect();
        let next = marks.get(k + 1).and_then(|&n| html[..n].rfind('<')).unwrap_or(html.len());
        let body = &html[tag_end + 1..next.max(tag_end + 1)];
        let main = body.split("contentRow-minor").next().unwrap_or(body);
        let main = main.split("<time").next().unwrap_or(main);
        let hrefs: Vec<(&str, &str)> = body.match_indices("<a ").filter_map(|(i, _)| {
            let t = &body[i..i + body[i..].find('>').unwrap_or(0)];
            let h = t.find("href=\"")? + 6;
            Some((t, t[h..].split('"').next()?))
        }).collect();
        let href = hrefs.iter().find(|(t, _)| t.contains("fauxBlockLink-blockLink")).or_else(|| hrefs.iter().find(|(_, h)| !h.contains("/members/"))).map(|x| decode_entities(x.1)).unwrap_or_else(|| "/account/alerts".into());
        let at = body.find("data-time=\"").and_then(|i| body[i + 11..].split('"').next()?.parse::<i64>().ok()).unwrap_or(0) * 1000;
        let text = plain(main);
        out.push(json!({ "id": id, "text": if text.is_empty() { "התראה חדשה".into() } else { text }, "url": f.link(&href), "at": at, "unread": tag.contains("is-unread") }));
    }
    out
}

// ---------- logging in ----------
enum Fail { Bad(String), Net(String) } // Bad = the forum said no (do not try again by itself); Net = try later
// XenForo answers JSON only with its csrf token ("_xfToken", also for a GET: "security error" without it). The
// token is in every page (<html data-csrf>); a page is heavy (prog: ~340 KB), so it is read once and kept in memory.
static XF_TOKEN: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
/// A signed-in page of the account: Some(true) = signed in (its navigation has the alerts badge); keeps the token.
fn xf_page(f: &Forum, cookie: &str) -> Option<(bool, String)> {
    let (r, raw) = get(&format!("{}/account/preferences", f.base), cookie, "")?;
    if r.status >= 500 { return None }
    let html = body_str(&r);
    if let Some(t) = html.find("data-csrf=\"").and_then(|i| html[i + 11..].split('"').next()).filter(|t| !t.is_empty()) {
        XF_TOKEN.lock().unwrap().insert(f.id.to_string(), t.to_string());
    }
    Some((r.status == 200 && html.contains("js-badge--alerts"), raw))
}
fn signed_in(f: &Forum, cookie: &str) -> Option<bool> {
    if f.xf { return xf_page(f, cookie).map(|x| x.0) }
    let (r, _) = get(&format!("{}/api/config", f.base), cookie, "")?;
    if r.status != 200 { return None }
    serde_json::from_slice::<Value>(&r.body).ok().map(|v| v["loggedIn"].as_bool().unwrap_or(false))
}
/// Logs in with a username and password; Ok = the Cookie header of the session.
fn creds_login(f: &Forum, user: &str, pass: &str) -> Result<String, Fail> {
    let net = || Fail::Net("הפורום לא ענה".into());
    if f.xf {
        let (r, raw) = get(&format!("{}/login/", f.base), "", "").ok_or_else(net)?;
        let html = body_str(&r);
        let tok = html.find("name=\"_xfToken\" value=\"").map(|i| i + 23).or_else(|| html.find("data-csrf=\"").map(|i| i + 11))
            .and_then(|i| html[i..].split('"').next().map(str::to_string)).ok_or_else(|| Fail::Net("לא נמצא טופס ההתחברות".into()))?;
        let cookie = merge_cookies("", &raw);
        let body = format!("login={}&password={}&remember=1&_xfToken={}&_xfRedirect={}&_xfResponseType=json", enc(user), enc(pass), enc(&tok), enc(&format!("{}/", f.base)));
        let h = format!("Cookie: {cookie}\r\nContent-Type: application/x-www-form-urlencoded\r\nX-Requested-With: XMLHttpRequest\r\nAccept: application/json\r\nReferer: {}/login/\r\n", f.base);
        let (r, raw) = http::fetch_plain("POST", &format!("{}/login/login", f.base), &h, body.as_bytes()).ok_or_else(net)?;
        let cookie = merge_cookies(&cookie, &raw);
        let v: Value = serde_json::from_slice(&r.body).unwrap_or_default();
        let ok = (v["status"] == "ok" || (300..400).contains(&r.status)) && (cookie.contains("xf_user=") || cookie.contains("xf_session="));
        if !ok {
            let b = body_str(&r).to_ascii_lowercase();
            if b.contains("captcha") { return Err(Fail::Bad("הפורום מבקש אימות. התחברו בחלון".into())) }
            let msg = v["errors"].as_array().and_then(|e| e.first()).and_then(Value::as_str).map(plain).filter(|s| !s.is_empty());
            return Err(if r.status >= 500 { net() } else { Fail::Bad(msg.unwrap_or_else(|| "ההתחברות נכשלה".into()).chars().take(120).collect()) });
        }
        return match signed_in(f, &cookie) { Some(true) => Ok(cookie), Some(false) => Err(Fail::Bad("ההתחברות נכשלה".into())), None => Err(net()) };
    }
    let (r, raw) = get(&format!("{}/api/config", f.base), "", "").ok_or_else(net)?;
    let v: Value = serde_json::from_slice(&r.body).map_err(|_| net())?;
    let csrf = v["csrf_token"].as_str().unwrap_or("").to_string();
    let cookie = merge_cookies("", &raw);
    let body = format!("username={}&password={}&remember=on&_csrf={}", enc(user), enc(pass), enc(&csrf));
    let h = format!("Cookie: {cookie}\r\nx-csrf-token: {csrf}\r\nContent-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\nX-Requested-With: XMLHttpRequest\r\nReferer: {}/login\r\nOrigin: {}\r\n", f.base, f.origin());
    let (r, raw) = http::fetch_plain("POST", &format!("{}/login", f.base), &h, body.as_bytes()).ok_or_else(net)?;
    let cookie = merge_cookies(&cookie, &raw);
    let b = body_str(&r);
    if r.status >= 500 { return Err(net()) }
    if r.status >= 400 {
        let lb = b.to_ascii_lowercase();
        let msg = if lb.contains("invalid") || lb.contains("password") || lb.contains("no-user") { "שם המשתמש או הסיסמה שגויים" }
            else if lb.contains("ban") { "המשתמש חסום בפורום" }
            else if lb.contains("csrf") { "הפורום דחה את הבקשה. נסו להתחבר בחלון" }
            else { "ההתחברות נכשלה" };
        return Err(Fail::Bad(msg.into()));
    }
    let next = serde_json::from_str::<Value>(&b).ok().and_then(|v| v["next"].as_str().map(str::to_string)).unwrap_or_default();
    if next.contains("2fa") || next.contains("register/complete") { return Err(Fail::Bad("הפורום מבקש אימות נוסף. התחברו בחלון".into())) }
    match signed_in(f, &cookie) { Some(true) => Ok(cookie), Some(false) => Err(Fail::Bad("ההתחברות נכשלה".into())), None => Err(net()) }
}

pub(crate) fn edge_path() -> Option<std::path::PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"].iter().filter_map(|v| std::env::var(v).ok())
        .map(|b| std::path::PathBuf::from(b).join(r"Microsoft\Edge\Application\msedge.exe")).find(|p| p.exists())
}
/// The forum's cookies in the Edge profile, over DevTools (Storage.getCookies sees HttpOnly ones too).
fn cdp_cookies(port_file: &std::path::Path, f: &Forum) -> Option<(u16, String, String)> {
    let s = std::fs::read_to_string(port_file).ok()?;
    let mut l = s.lines();
    let port: u16 = l.next()?.trim().parse().ok()?;
    let path = l.next()?.trim().to_string();
    let reply = http::ws_roundtrip(port, &path, r#"{"id":1,"method":"Storage.getCookies"}"#)?;
    Some((port, path, cookies_for(&reply, f)))
}
pub fn cookies_for(reply: &str, f: &Forum) -> String {
    let v: Value = serde_json::from_str(reply).unwrap_or_default();
    let host = f.host();
    v["result"]["cookies"].as_array().into_iter().flatten().filter(|c| {
        let d = c["domain"].as_str().unwrap_or("").trim_start_matches('.');
        !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")))
    }).filter_map(|c| Some(format!("{}={}", c["name"].as_str()?, c["value"].as_str()?))).collect::<Vec<_>>().join("; ")
}
fn has_login_cookie(f: &Forum, cookie: &str) -> bool {
    let has = |n: &str| cookie.split("; ").any(|p| p.starts_with(&format!("{n}=")));
    if f.xf { has("xf_user") || has("xf_session") } else { has("express.sid") }
}
/// The login window: the forum's login page; done when its cookie signs in (Edge is closed then), or after the
/// user closes the window (one headless read of the profile then).
fn window_login(f: &Forum) -> Result<String, String> {
    let edge = edge_path().ok_or("Microsoft Edge לא נמצא במחשב")?;
    let profile = data_dir().join("forum-signin");
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);
    let login = if f.xf { format!("{}/login/", f.base) } else { format!("{}/login", f.base) };
    let mut win = std::process::Command::new(&edge)
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0"])
        .arg(format!("--app={login}"))
        .spawn().map_err(|_| "Edge לא נפתח".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(900);
    let mut tried = String::new();
    loop {
        std::thread::sleep(Duration::from_millis(1500));
        let closed = matches!(win.try_wait(), Ok(Some(_)));
        if !closed {
            if let Some((port, path, cookie)) = cdp_cookies(&port_file, f) {
                if cookie != tried && has_login_cookie(f, &cookie) {
                    tried = cookie.clone();
                    if signed_in(f, &cookie) == Some(true) {
                        let _ = http::ws_roundtrip(port, &path, r#"{"id":2,"method":"Browser.close"}"#);
                        std::thread::sleep(Duration::from_millis(500));
                        let _ = win.kill();
                        return Ok(cookie);
                    }
                }
            }
        }
        if closed { break }
        if Instant::now() > deadline { let _ = win.kill(); return Err("עבר הזמן להתחברות".into()) }
    }
    // Closed by the user: read the profile once, headless.
    std::thread::sleep(Duration::from_millis(1500));
    let _ = std::fs::remove_file(&port_file);
    let mut child = std::process::Command::new(&edge)
        .arg(format!("--user-data-dir={}", profile.display()))
        .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "about:blank"])
        .spawn().map_err(|_| "Edge לא נפתח".to_string())?;
    let mut result = Err("לא נמצאה התחברות. התחברו בחלון וחכו שהוא ייסגר לבד.".to_string());
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(500));
        let Some((port, path, cookie)) = cdp_cookies(&port_file, f) else { continue };
        if has_login_cookie(f, &cookie) && signed_in(f, &cookie) == Some(true) { result = Ok(cookie); }
        let _ = http::ws_roundtrip(port, &path, r#"{"id":2,"method":"Browser.close"}"#);
        break;
    }
    std::thread::sleep(Duration::from_millis(500));
    let _ = child.kill();
    result
}

fn start_run(id: &str, job: impl FnOnce() -> Result<Value, String> + Send + 'static) {
    {
        let mut runs = RUNS.lock().unwrap();
        if runs.get(id) == Some(&Run::Pending) { return }
        runs.insert(id.to_string(), Run::Pending);
    }
    let id = id.to_string();
    std::thread::spawn(move || {
        let r = job();
        let mut runs = RUNS.lock().unwrap();
        match r {
            Ok(sec) => {
                runs.remove(&id);
                drop(runs);
                with_secrets(|m| { m.insert(id.clone(), sec); save_secrets(m); });
                // a new session: the first poll only calibrates (no toasts for what was there before)
                with_state(|m| { m.insert(id.clone(), json!({})); save_state(m); });
                DUE.lock().unwrap().insert(id.clone(), Instant::now());
                log(&format!("forums {id}: connected"));
            }
            Err(e) => { log(&format!("forums {id}: connect failed")); runs.insert(id, Run::Failed(e)); }
        }
    });
}

// ---------- polling ----------
enum Got { Fresh(Vec<Value>, Option<i64>, Option<i64>), Same(Option<i64>), Expired, Down(u32) }
fn poll_nodebb(f: &Forum, cookie: &mut String, st: &Value) -> Got {
    let etag = st["etag"].as_str().unwrap_or("");
    let extra = if etag.is_empty() || st["items"].is_null() { String::new() } else { format!("If-None-Match: {etag}\r\n") };
    let Some((r, raw)) = get(&format!("{}/api/notifications", f.base), cookie, &extra) else { return Got::Down(0) };
    *cookie = merge_cookies(cookie, &raw);
    let chats = || get(&format!("{}/api/v3/chats/unread", f.base), cookie, "").filter(|(r, _)| r.status == 200)
        .and_then(|(r, _)| serde_json::from_slice::<Value>(&r.body).ok())
        .and_then(|v| num(&v["response"]["count"]).or(num(&v["response"]["unread"])).or(num(&v["response"])));
    match r.status {
        304 => Got::Same(chats()),
        200 => {
            let Ok(v) = serde_json::from_slice::<Value>(&r.body) else { return Got::Down(200) };
            if v["status"]["code"] == "not-authorised" { return Got::Expired }
            let items = parse_nodebb(f, &v);
            let count = get(&format!("{}/api/v3/notifications/count", f.base), cookie, "").filter(|(r, _)| r.status == 200)
                .and_then(|(r, _)| serde_json::from_slice::<Value>(&r.body).ok()).and_then(|v| num(&v["response"]["unread"]).or(num(&v["response"]["count"])));
            let e = header(&raw, "etag").next().unwrap_or("").to_string();
            with_state(|m| { if let Some(s) = m.get_mut(f.id) { s["etag"] = json!(e); } });
            Got::Fresh(items, count, chats())
        }
        401 | 403 => Got::Expired,
        s => Got::Down(s),
    }
}
/// A JSON GET with the token; a "security error" (old token) reads a page for a new one and asks again.
fn xf_json(f: &Forum, cookie: &mut String, path: &str) -> Option<http::Reply> {
    for again in [false, true] {
        let tok = XF_TOKEN.lock().unwrap().get(f.id).cloned();
        let tok = match tok { Some(t) if !again => t, _ => { let (_, raw) = xf_page(f, cookie)?; *cookie = merge_cookies(cookie, &raw); XF_TOKEN.lock().unwrap().get(f.id).cloned()? } };
        let (r, raw) = get(&format!("{}{path}{}_xfResponseType=json&_xfToken={}", f.base, if path.contains('?') { "&" } else { "?" }, enc(&tok)), cookie, "X-Requested-With: XMLHttpRequest\r\n")?;
        *cookie = merge_cookies(cookie, &raw);
        if r.status == 400 && !again { continue }
        return Some(r);
    }
    None
}
fn poll_xf(f: &Forum, cookie: &mut String, st: &Value) -> Got {
    // the small account menu: its JSON carries the visitor's counts
    let Some(r) = xf_json(f, cookie, "/account/visitor-menu") else { return Got::Down(0) };
    if r.status == 401 || r.status == 403 { return Got::Expired }
    if r.status != 200 { return Got::Down(r.status) }
    let Some((alerts, convs)) = xf_counts(&body_str(&r)) else { return Got::Expired };
    // The list only when there is something new, the first time, or every 6th check (opening it marks alerts "seen").
    let n = st["n"].as_i64().unwrap_or(0);
    if alerts == 0 && !st["items"].is_null() && n % 6 != 5 { return Got::Same(Some(convs)) }
    let Some(r) = xf_json(f, cookie, "/account/alerts-popup") else { return Got::Down(0) };
    if r.status != 200 { return Got::Same(Some(convs)) }
    let v: Value = serde_json::from_slice(&r.body).unwrap_or_default();
    let html = v["html"]["content"].as_str().map(str::to_string).unwrap_or_else(|| body_str(&r));
    let items = parse_xf_alerts(f, &html);
    let unread = items.iter().filter(|i| i["unread"] == true).count() as i64;
    Got::Fresh(items, Some(unread.max(alerts)), Some(convs))
}

fn poll(f: &'static Forum) {
    let Some(sec) = secret(f.id) else { return };
    let st = with_state(|m| m.get(f.id).cloned().unwrap_or_else(|| json!({})));
    if st["stop"].as_bool() == Some(true) { return }
    let mut cookie = sec["c"].as_str().unwrap_or("").to_string();
    let run = |cookie: &mut String| if f.xf { poll_xf(f, cookie, &st) } else { poll_nodebb(f, cookie, &st) };
    let mut got = run(&mut cookie);
    if matches!(got, Got::Expired) && sec["m"] == "creds" {
        match creds_login(f, sec["u"].as_str().unwrap_or(""), sec["p"].as_str().unwrap_or("")) {
            Ok(c) => { cookie = c; log(&format!("forums {}: logged in again", f.id)); got = run(&mut cookie); }
            Err(Fail::Bad(e)) => { log(&format!("forums {}: login refused", f.id)); return set_err(f.id, &e, true) }
            Err(Fail::Net(e)) => return set_err(f.id, &e, false),
        }
    }
    set_cookie_of(f.id, &cookie);
    match got {
        Got::Expired => { log(&format!("forums {}: session ended", f.id)); set_err(f.id, "החיבור פג. צריך להתחבר שוב", true) }
        Got::Down(s) => { log(&format!("forums {}: poll {s}", f.id)); set_err(f.id, "הפורום לא ענה", false) }
        Got::Same(chats) => with_state(|m| {
            let s = m.entry(f.id.to_string()).or_insert_with(|| json!({}));
            s["at"] = json!(now_ms()); s["err"] = Value::Null; s["n"] = json!(s["n"].as_i64().unwrap_or(0) + 1);
            if let Some(c) = chats { s["chats"] = json!(c); }
            save_state(m);
        }),
        Got::Fresh(items, count, chats) => {
            let fresh: Vec<Value> = with_state(|m| {
                let s = m.entry(f.id.to_string()).or_insert_with(|| json!({}));
                let primed = s["primed"].as_bool().unwrap_or(false);
                let seen: BTreeSet<String> = s["seen"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect();
                let fresh: Vec<Value> = if primed { items.iter().filter(|i| i["unread"] == true && !seen.contains(i["id"].as_str().unwrap_or(""))).cloned().collect() } else { vec![] };
                let mut all: Vec<String> = items.iter().filter_map(|i| i["id"].as_str().map(str::to_string)).collect();
                all.extend(seen.into_iter().take(200));
                all.dedup();
                s["seen"] = json!(all.into_iter().take(300).collect::<Vec<_>>());
                s["primed"] = json!(true);
                s["unread"] = json!(count.unwrap_or(items.iter().filter(|i| i["unread"] == true).count() as i64));
                if let Some(c) = chats { s["chats"] = json!(c); }
                s["items"] = json!(items.iter().take(30).cloned().collect::<Vec<_>>());
                s["at"] = json!(now_ms()); s["err"] = Value::Null; s["n"] = json!(s["n"].as_i64().unwrap_or(0) + 1);
                save_state(m);
                fresh
            });
            toasts(f, &fresh);
        }
    }
}
fn set_err(id: &str, e: &str, stop: bool) {
    with_state(|m| {
        let s = m.entry(id.to_string()).or_insert_with(|| json!({}));
        s["err"] = json!(e);
        if stop { s["stop"] = json!(true); }
        save_state(m);
    });
}
/// New notifications as toasts: at most 3 a forum, then one "and N more". Nothing on shabbat and yom tov
/// (crate::quiet_now: the page's windows); they are counted as seen all the same, so nothing piles up for after.
fn toasts(f: &Forum, fresh: &[Value]) {
    if fresh.is_empty() || !notify_on(f.id) || crate::quiet_now(0) { return }
    for i in fresh.iter().take(3) {
        if let Err(e) = crate::notify::toast(f.name, i["text"].as_str().unwrap_or(""), i["url"].as_str().unwrap_or(f.base), "", "") { log(&format!("forums toast: {e}")); }
    }
    if fresh.len() > 3 {
        let _ = crate::notify::toast(f.name, &format!("ועוד {} התראות חדשות", fresh.len() - 3), &f.link(if f.xf { "/account/alerts" } else { "/notifications" }), "", "");
    }
}
fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

/// The background poller: each connected forum every `interval` (the card's setting), or now when asked.
pub fn start() {
    std::thread::spawn(|| loop {
        let every = interval();
        let ids: Vec<&'static Forum> = FORUMS.iter().filter(|f| secret(f.id).is_some()).collect();
        let mut polled = false;
        for f in ids {
            let due = DUE.lock().unwrap().get(f.id).copied();
            if due.is_none_or(|d| Instant::now() >= d) {
                DUE.lock().unwrap().insert(f.id.to_string(), Instant::now() + every);
                poll(f);
                polled = true;
            }
        }
        if polled { crate::widgets::push(&json!({ "forums": summary() }).to_string()); }
        std::thread::sleep(Duration::from_secs(5));
    });
}

/// The widget's "רענון": every connected forum is due now (the poller takes them within 5 s and pushes).
pub fn poll_now() {
    let mut due = DUE.lock().unwrap();
    for f in FORUMS.iter() { due.insert(f.id.to_string(), Instant::now()); }
}

/// The widget: big = all unread, sub = the newest unread, rows = forum -> unread.
fn summary() -> Value {
    let list = list_json();
    let on: Vec<&Value> = list["forums"].as_array().into_iter().flatten().filter(|f| f["connected"] == true).collect();
    if on.is_empty() { return json!({ "big": "", "sub": "לא מחוברים לפורום", "rows": [] }) }
    let total: i64 = on.iter().map(|f| f["unread"].as_i64().unwrap_or(0) + f["chats"].as_i64().unwrap_or(0)).sum();
    let newest = on.iter().flat_map(|f| f["items"].as_array().into_iter().flatten().filter(|i| i["unread"] == true).map(move |i| (i["at"].as_i64().unwrap_or(0), format!("{}: {}", f["name"].as_str().unwrap_or(""), i["text"].as_str().unwrap_or(""))))).max_by_key(|x| x.0);
    let mut rows: Vec<&&Value> = on.iter().collect();
    rows.sort_by_key(|f| std::cmp::Reverse(f["unread"].as_i64().unwrap_or(0)));
    // One summary per forum, for a widget set to it (widgets.rs per_pick): its count, its newest unread, its items.
    let per: serde_json::Map<String, Value> = on.iter().map(|f| {
        let n = f["unread"].as_i64().unwrap_or(0) + f["chats"].as_i64().unwrap_or(0);
        let items: Vec<&Value> = f["items"].as_array().into_iter().flatten().take(4).collect();
        let newest = items.iter().find(|i| i["unread"] == true).and_then(|i| i["text"].as_str()).unwrap_or(if n == 0 { "אין התראות חדשות" } else { "" });
        (f["id"].as_str().unwrap_or("").to_string(), json!({
            "name": f["name"], "big": n.to_string(), "sub": newest.chars().take(80).collect::<String>(),
            "rows": items.iter().map(|i| json!([i["text"].as_str().unwrap_or("").chars().take(40).collect::<String>(), "", i["unread"] == true, i["url"]])).collect::<Vec<_>>(),
        }))
    }).collect();
    json!({
        "per": per,
        "big": total.to_string(),
        "sub": newest.map(|n| n.1.chars().take(80).collect::<String>()).unwrap_or_else(|| if total == 0 { "אין התראות חדשות".into() } else { String::new() }),
        "rows": rows.iter().map(|f| {
            let n = f["unread"].as_i64().unwrap_or(0);
            let err = f["err"].is_string();
            json!([f["name"], if err { "צריך להתחבר".to_string() } else { n.to_string() }, n > 0 || err])
        }).collect::<Vec<_>>(),
    })
}

fn list_json() -> Value {
    let runs = RUNS.lock().unwrap().clone();
    let forums: Vec<Value> = FORUMS.iter().map(|f| {
        let sec = secret(f.id);
        let st = with_state(|m| m.get(f.id).cloned().unwrap_or_else(|| json!({})));
        let (pending, failed) = match runs.get(f.id) { Some(Run::Pending) => (true, Value::Null), Some(Run::Failed(e)) => (false, json!(e)), None => (false, Value::Null) };
        json!({
            "id": f.id, "name": f.name, "url": f.base, "kind": if f.xf { "xenforo" } else { "nodebb" },
            "connected": sec.is_some(),
            "mode": sec.as_ref().map(|s| s["m"].clone()).unwrap_or(Value::Null),
            "user": sec.as_ref().and_then(|s| s["u"].as_str().map(str::to_string)).map(Value::from).unwrap_or(Value::Null),
            "pending": pending, "failed": failed,
            "unread": st["unread"], "chats": st["chats"], "items": st["items"].as_array().map(|a| a.iter().take(30).cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "at": st["at"], "err": st["err"],
        })
    }).collect();
    json!({ "forums": forums, "quiet": crate::quiet_now(0) })
}

/// The POST body of a page request (the board hands it over as a stream). Empty when there is none.
pub fn request_body(req: &crate::bindings::FeedResourceRequest) -> Vec<u8> {
    (|| -> windows_core::Result<Vec<u8>> {
        let s = req.Content()?.OpenReadAsync()?.join()?;
        let size = s.Size()?;
        if size == 0 || size > 1024 * 1024 { return Ok(vec![]) }
        let rd = crate::bindings::DataReader::CreateDataReader(&s.GetInputStreamAt(0)?)?;
        let n = rd.LoadAsync(size as u32)?.join()?;
        let mut v = vec![0u8; n as usize];
        rd.ReadBytes(&mut v)?;
        Ok(v)
    })().unwrap_or_default()
}

/// /board/forum?do=list|login|creds|logout|poll&id=<forum id>. `creds` takes {"user","pass"} in a POST body only.
pub fn route(q: &str, req: &crate::bindings::FeedResourceRequest) -> (Vec<u8>, String, i32) {
    let jsn = |v: Value| (v.to_string().into_bytes(), "application/json".to_string(), 200);
    let bad = |m: &str| (m.as_bytes().to_vec(), "text/plain".to_string(), 400);
    let what = http::query(q, "do").next().unwrap_or_default();
    let id = http::query(q, "id").next().unwrap_or_default();
    if what == "list" || what.is_empty() { return jsn(list_json()) }
    let Some(f) = forum(&id) else { return bad("forum") };
    match what.as_str() {
        "login" => start_run(f.id, move || window_login(f).map(|c| json!({ "m": "window", "c": c }))),
        "creds" => {
            let method = req.Method().map(|m| m.to_string_lossy()).unwrap_or_default();
            if !method.eq_ignore_ascii_case("POST") { return bad("post only") }
            let v: Value = serde_json::from_slice(&request_body(req)).unwrap_or_default();
            let (user, pass) = (v["user"].as_str().unwrap_or("").trim().to_string(), v["pass"].as_str().unwrap_or("").to_string());
            if user.is_empty() || pass.is_empty() { return bad("empty") }
            start_run(f.id, move || match creds_login(f, &user, &pass) {
                Ok(c) => Ok(json!({ "m": "creds", "c": c, "u": user, "p": pass })),
                Err(Fail::Bad(e) | Fail::Net(e)) => Err(e),
            });
        }
        "logout" => {
            with_secrets(|m| { m.remove(f.id); save_secrets(m); });
            with_state(|m| { m.remove(f.id); save_state(m); });
            RUNS.lock().unwrap().remove(f.id);
            crate::widgets::push(&json!({ "forums": summary() }).to_string());
        }
        "poll" => { DUE.lock().unwrap().insert(f.id.to_string(), Instant::now()); }
        "clear" => { RUNS.lock().unwrap().remove(f.id); }
        _ => return bad("do"),
    }
    jsn(list_json())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mit() -> &'static Forum { forum("mitmachim").unwrap() }
    #[test]
    fn links() {
        let o = forum("otzaria").unwrap();
        assert_eq!(o.link("/post/5"), "https://otzaria.org/forum/post/5");
        assert_eq!(o.link("/forum/post/5"), "https://otzaria.org/forum/post/5");
        assert_eq!(mit().link("/topic/1/x"), "https://mitmachim.top/topic/1/x");
        assert_eq!(forum("solidit").unwrap().link("/kehila/threads/a.1/"), "https://www.hasolidit.com/kehila/threads/a.1/");
    }
    #[test]
    fn cookies_merge() {
        let raw = "HTTP/1.1 200 OK\r\nSet-Cookie: express.sid=s%3Anew; Path=/; Expires=Wed, 01 Dec 2026 00:00:00 GMT; HttpOnly; Secure\r\nset-cookie: old=; Max-Age=0\r\nETag: W/\"abc\"\r\n";
        assert_eq!(merge_cookies("express.sid=s%3Aold; old=1; keep=2", raw), "keep=2; express.sid=s%3Anew");
        assert_eq!(header(raw, "etag").next(), Some("W/\"abc\""));
    }
    #[test]
    fn nodebb_shape() {
        // NodeBB's documented /api/notifications shape (public/openapi/read/notifications.yaml)
        let v: Value = serde_json::from_str(r#"{"notifications":[
            {"nid":"new_post:tid:12:pid:345:uid:7","bodyShort":"[[notifications:user-posted-to, <strong>יוסי</strong>, <strong>שאלה על &quot;הלוח&quot;</strong>]]","path":"/post/345","datetime":1763200000000,"read":false,"user":{"username":"יוסי"}},
            {"nid":"mention:pid:9","bodyShort":"<strong>דוד</strong> הזכיר אותך ב<strong>נושא</strong>","datetime":1763100000000,"read":true},
            {"nid":"follow:7","bodyShort":"[[notifications:user-started-following-you, <strong>[[global:guest]]</strong>]]","path":"/user/x","datetime":1763150000000,"read":false}],
            "unreadNids":[],"pagination":{}}"#).unwrap();
        let it = parse_nodebb(mit(), &v);
        assert_eq!(it.len(), 3);
        assert_eq!(it[0]["text"], "יוסי הגיב/ה בשאלה על \"הלוח\"");
        assert_eq!(it[0]["url"], "https://mitmachim.top/post/345");
        assert_eq!(it[0]["unread"], true);
        assert_eq!(it[1]["text"], "אורח עוקב/ת אחריך");
        assert_eq!(it[2]["text"], "דוד הזכיר אותך בנושא");
        assert_eq!(it[2]["url"], "https://mitmachim.top/post/9");
        assert_eq!(it[2]["unread"], false);
    }
    #[test]
    fn guest_reply() {
        // the Pi's guest answer (research/pi-forums-result.txt): 401 with status.code not-authorised
        let v: Value = serde_json::from_str(r#"{"status":{"code":"not-authorised","message":"x"},"response":{}}"#).unwrap();
        assert_eq!(v["status"]["code"], "not-authorised");
        assert!(parse_nodebb(mit(), &v).is_empty());
    }
    #[test]
    fn xenforo() {
        let p = forum("prog").unwrap();
        assert_eq!(xf_counts(r#"{"status":"ok","html":{"content":""},"visitor":{"conversations_unread":"1","alerts_unviewed":"3","total_unread":"4"}}"#), Some((3, 1)));
        assert_eq!(xf_counts(r#"{"status":"error","errors":["x"]}"#), None);
        assert_eq!(xf_counts(r#"<a href="/account/alerts" class="p-navgroup-link js-badge--alerts badgeContainer" data-badge="2">x</a><a class="js-badge--conversations" data-badge="0">"#), Some((2, 0)));
        let html = r#"<ul class="listPlain">
<li class="menu-row menu-row--separated menu-row--clickable is-unread js-alert" data-alert-id="991" data-xf-init="quick-mark-read">
 <div class="fauxBlockLink"><div class="contentRow"><div class="contentRow-figure"><a href="/members/a.5/" class="avatar"></a></div>
 <div class="contentRow-main contentRow-main--close"><a href="/members/a.5/" class="username">אבי</a> הגיב לנושא <a href="/threads/abc.77/post-123" class="fauxBlockLink-blockLink">מתכון &amp; עוד</a>.
 <div class="contentRow-minor contentRow-minor--smaller"><time class="u-dt" data-time="1763200000" datetime="x">היום</time></div></div></div></div></li>
<li class="menu-row menu-row--separated js-alert" data-alert-id="990"><div class="contentRow-main"><a href="/members/b.6/" class="username">בני</a> אהב את ההודעה שלך <a href="https://www.prog.co.il/threads/x.1/">כאן</a><div class="contentRow-minor"><time data-time="1763100000"></time></div></div></li></ul>"#;
        let it = parse_xf_alerts(p, html);
        assert_eq!(it.len(), 2);
        assert_eq!(it[0]["id"], "991");
        assert_eq!(it[0]["text"], "אבי הגיב לנושא מתכון & עוד.");
        assert_eq!(it[0]["url"], "https://www.prog.co.il/threads/abc.77/post-123");
        assert_eq!(it[0]["at"], 1763200000000i64);
        assert_eq!(it[0]["unread"], true);
        assert_eq!(it[1]["unread"], false);
        assert_eq!(it[1]["url"], "https://www.prog.co.il/threads/x.1/");
    }
    #[test]
    fn devtools_cookies() {
        let j = r#"{"id":1,"result":{"cookies":[{"name":"express.sid","value":"s%3Aa","domain":"mitmachim.top","path":"/"},{"name":"g","value":"x","domain":".google.com"},{"name":"xf_user","value":"1","domain":".prog.co.il"}]}}"#;
        assert_eq!(cookies_for(j, mit()), "express.sid=s%3Aa");
        assert_eq!(cookies_for(j, forum("prog").unwrap()), "xf_user=1");
        assert!(has_login_cookie(mit(), "a=1; express.sid=x"));
        assert!(!has_login_cookie(forum("prog").unwrap(), "xf_csrf=1"));
    }
    // Guest requests only, no account: cargo test -- --ignored guest_network
    #[test]
    #[ignore]
    fn guest_network() {
        let (r, raw) = get("https://mitmachim.top/api/config", "", "").unwrap();
        let v: Value = serde_json::from_slice(&r.body).unwrap();
        assert!(v["csrf_token"].as_str().is_some_and(|t| !t.is_empty()));
        assert!(merge_cookies("", &raw).contains("express.sid="));
        assert_eq!(signed_in(mit(), ""), Some(false));
        let (r, _) = get("https://mitmachim.top/api/notifications", "", "").unwrap();
        assert_eq!(r.status, 401);
        let p = forum("prog").unwrap();
        let (r, _) = get(&format!("{}/login/", p.base), "", "").unwrap();
        assert!(body_str(&r).contains("name=\"_xfToken\" value=\""), "{}", r.status);
        assert_eq!(signed_in(p, ""), Some(false));
        assert!(XF_TOKEN.lock().unwrap().get("prog").is_some());
        // a guest with the token: a JSON error, not the security error, and no visitor counts
        let mut c = String::new();
        let r = xf_json(p, &mut c, "/account/visitor-menu").unwrap();
        assert_eq!(xf_counts(&body_str(&r)), None, "{}", r.status);
    }
    #[test]
    fn form_encoding() { assert_eq!(enc("a b&c=ד"), "a%20b%26c%3D%D7%93"); }
}
