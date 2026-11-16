// "הלוח" for the Windows widgets board: a Windows App SDK feed provider and widget provider (out-of-proc COM server).
// The board loads https://the-young-boy.github.io/HaLuach/board/ (the dev copy: its own private host, so an installed release
// beside it never gets its requests); WebRequestFilter routes that path to OnResourceRequested, which answers with the
// embedded page. Nothing is ever served from those hosts: every request under /board/ is answered here.
#![windows_subsystem = "windows"]
#![allow(non_snake_case)]

#[allow(warnings)]
mod bindings;
mod bg;
mod buses;
mod books;
mod forums;
mod horizon;
mod http;
mod notify;
mod podcasts;
mod youtube;
mod ytlogin;
mod radio;
mod redalert;
mod shipments;
mod sysvol;
mod update;
mod widgets;
mod zmanim;

use bindings::*;
use core::ffi::c_void;
use std::collections::BTreeMap;
use windows_core::{implement, interface, IUnknown, Interface, Ref, BOOL, GUID, HRESULT, HSTRING};

// Must match AppxManifest.xml. The distribution build sets its own, so it can sit next to the dev package.
const CLSID: &str = match option_env!("HL_CLSID") { Some(s) => s, None => "F85756F5-BFE8-4602-8E67-01532B35D253" };
const WCLSID: &str = match option_env!("HL_WCLSID") { Some(s) => s, None => "5D6EE3CC-E6D3-462A-AD07-F05CF4816599" };
const PAGE: &str = include_str!("board.html");
/// The name of the data folder under %LOCALAPPDATA% (settings, widget state, caches).
pub const APPDIR: &str = "HaLuach";

#[link(name = "ole32")]
unsafe extern "system" {
    pub fn CoInitializeEx(reserved: *const c_void, coinit: u32) -> HRESULT;
    fn CoRegisterClassObject(clsid: *const GUID, unk: *mut c_void, ctx: u32, flags: u32, cookie: *mut u32) -> HRESULT;
    fn CoWaitForMultipleObjects(flags: u32, timeout: u32, n: u32, handles: *const *mut c_void, index: *mut u32) -> HRESULT;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentApplicationUserModelId(len: *mut u32, id: *mut u16) -> i32;
    fn GetCurrentPackageFamilyName(len: *mut u32, name: *mut u16) -> i32;
    fn CreateEventW(attr: *const c_void, manual: BOOL, initial: BOOL, name: *const u16) -> *mut c_void;
}
#[link(name = "shell32")]
unsafe extern "system" {
    fn SetCurrentProcessExplicitAppUserModelID(id: *const u16) -> HRESULT;
    fn ShellExecuteW(hwnd: *mut c_void, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> *mut c_void;
}
#[link(name = "shlwapi")]
unsafe extern "system" {
    fn SHCreateMemStream(data: *const u8, len: u32) -> *mut c_void;
}
#[link(name = "shcore")]
unsafe extern "system" {
    fn CreateRandomAccessStreamOverStream(stream: *mut c_void, opts: u32, iid: *const GUID, out: *mut *mut c_void) -> HRESULT;
}

pub fn data_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join(APPDIR)
}

/// Shabbat or yom tov now (or within `before_ms` of its start)? The page writes the windows (candles to nightfall)
/// with the notification plan. The user's rule: nothing goes out then; no update either, nor 2 hours before.
pub fn quiet_now(before_ms: i64) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let w: Vec<(i64, i64)> = std::fs::read(data_dir().join("quiet.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    if w.iter().any(|(a, b)| now >= a - before_ms && now < *b) { return true }
    // Past quiet.json's last window (the page wrote it long ago, or never): the computed Shabbat.
    let last = w.iter().map(|w| w.1).max().unwrap_or(i64::MIN);
    now + before_ms >= last && [now, now + before_ms].iter().any(|&t| shabbat_at(t).is_some_and(|(a, b)| now >= a - before_ms && now < b))
}
/// The computed Shabbat around unix ms `t`: [Friday sunset - 40 min, Saturday nightfall) of t's local Friday or
/// Saturday (None on other days), at the user's place (settings lat/lng/elev, else Jerusalem). Nightfall: the zmanim
/// card's chosen tzeit, else tzeit_8_5. Yom tov is not computed here (no Hebrew calendar in the provider): only the
/// page's quiet.json covers it.
pub fn shabbat_at(t: i64) -> Option<(i64, i64)> {
    let st = widgets::settings_value();
    let num = |k: &str| st[k].as_f64().or_else(|| st["loc"][k].as_f64());
    let (lat, lng) = match (num("lat"), num("lng")) { (Some(a), Some(b)) => (a, b), _ => (31.778, 35.235) };
    let elev = num("elev").unwrap_or(0.0);
    let tzeit = st["cards"]["zmanim"]["method"]["tzeit"].as_str().unwrap_or("tzeit_8_5").to_string();
    let day = widgets::local(t).0;
    // 1970-01-01 was a Thursday: days % 7 == 1 is a Friday, 2 a Saturday.
    let fri = match day.rem_euclid(7) { 1 => day, 2 => day - 1, _ => return None };
    let f = zmanim::compute(fri, lat, lng, elev).t;
    let s = zmanim::compute(fri + 1, lat, lng, elev).t;
    let start = f.get("sunset")?.as_i64()? - 40 * 60_000;
    let end = s.get(tzeit.as_str()).and_then(|v| v.as_i64()).or_else(|| s.get("tzeit_8_5").and_then(|v| v.as_i64()))?;
    Some((start, end))
}

fn respond(body: &[u8], mime: &str, status: i32) -> windows_core::Result<FeedResourceResponse> {
    unsafe {
        let istream = SHCreateMemStream(body.as_ptr(), body.len() as u32);
        if istream.is_null() {
            return Err(windows_core::Error::from_hresult(HRESULT(0x8007000Eu32 as i32))); // E_OUTOFMEMORY
        }
        let istream = IUnknown::from_raw(istream);
        let mut ras = core::ptr::null_mut();
        CreateRandomAccessStreamOverStream(istream.as_raw(), 0, &IRandomAccessStream::IID, &mut ras).ok()?;
        let ras = IRandomAccessStream::from_raw(ras);
        let r = FeedResourceResponse::CreateInstance(&RandomAccessStreamReference::CreateFromStream(&ras)?, &HSTRING::from(if status < 400 { "OK" } else { "Error" }), status)?;
        let mut h = BTreeMap::new();
        h.insert(HSTRING::from("Content-Type"), HSTRING::from(mime));
        h.insert(HSTRING::from("Cache-Control"), HSTRING::from("no-store"));
        r.SetHeaders(&windows_collections::IMapView::<HSTRING, HSTRING>::from(h).cast::<windows_collections::IIterable<windows_collections::IKeyValuePair<HSTRING, HSTRING>>>()?)?;
        Ok(r)
    }
}

#[implement(IFeedProvider, IFeedResourceProvider)]
struct Provider;

/// One line in %TEMP%\haluach.log (the board has no console).
pub fn log(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("haluach.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{t} {msg}");
    }
}

/// FNV-1a of the embedded page: changes exactly when the page changes.
fn page_hash() -> String {
    let h = PAGE.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
    format!("{h:016x}")
}

fn set_query(provider_id: windows_core::Result<HSTRING>) -> windows_core::Result<()> {
    let id = provider_id?;
    FeedManager::GetDefault()?.SetCustomQueryParameters(&CustomQueryParametersUpdateOptions::CreateInstance(&id, &HSTRING::new())?)
}

impl IFeedProvider_Impl for Provider_Impl {
    fn OnFeedProviderEnabled(&self, a: Ref<FeedProviderEnabledArgs>) -> windows_core::Result<()> { log("OnFeedProviderEnabled"); set_query(a.ok()?.FeedProviderDefinitionId()) }
    fn OnFeedProviderDisabled(&self, _a: Ref<FeedProviderDisabledArgs>) -> windows_core::Result<()> { Ok(()) }
    fn OnFeedEnabled(&self, _a: Ref<FeedEnabledArgs>) -> windows_core::Result<()> { Ok(()) }
    fn OnFeedDisabled(&self, _a: Ref<FeedDisabledArgs>) -> windows_core::Result<()> { Ok(()) }
    fn OnCustomQueryParametersRequested(&self, a: Ref<CustomQueryParametersRequestedArgs>) -> windows_core::Result<()> { set_query(a.ok()?.FeedProviderDefinitionId()) }
}

/// The query string after `/board/<name>?`, if the uri is that path.
fn route<'a>(uri: &'a str, name: &str) -> Option<&'a str> {
    let at = uri.find(&format!("/board/{name}"))?;
    let rest = &uri[at + 7 + name.len()..];
    if !(rest.is_empty() || rest.starts_with('?') || rest.starts_with('#')) { return None }
    Some(rest.trim_start_matches('?'))
}

impl IFeedResourceProvider_Impl for Provider_Impl {
    fn OnResourceRequested(&self, args: Ref<FeedResourceRequestedArgs>) -> windows_core::Result<()> {
        let args = args.ok()?;
        let uri = args.Request()?.Uri()?.to_string_lossy();
        // /board/forum?do=..: forum notifications (forums.rs); it reads the POST body, so it gets the request.
        if let Some(q) = route(&uri, "forum") { let (b, m, s) = forums::route(q, &args.Request()?); return args.SetResponse(&respond(&b, &m, s)?) }
        // A POST body is the request's `d` (big data: settings, the plan, widget summaries; an address is too short).
        let req = args.Request()?;
        let posted = String::from_utf8_lossy(&forums::request_body(&req)).into_owned();
        // A POST whose body came back empty (too big for request_body, or unreadable) must not count as "no d".
        let post = req.Method().map(|m| m.to_string_lossy().eq_ignore_ascii_case("POST")).unwrap_or(false);
        let (body, mime, status) = handle(&uri, &posted, post);
        args.SetResponse(&respond(&body, &mime, status)?)
    }
}

/// Everything the page asks for: (body, content type, status).
fn handle(uri: &str, posted: &str, post: bool) -> (Vec<u8>, String, i32) {
    let text = |s: String| (s.into_bytes(), "text/plain; charset=utf-8".to_string(), 200);
    let jsn = |s: String| (s.into_bytes(), "application/json".to_string(), 200);
    let p = |q: &str, k: &str| if k == "d" && !posted.is_empty() { posted.to_string() } else { http::query(q, k).next().unwrap_or_default() };
    // The board keeps the page alive across openings; the page polls this to reload itself after a deploy.
    if route(uri, "version").is_some() { return text(page_hash()) }
    if let Some(q) = route(uri, "log") {
        log(&format!("page: {}", p(q, "m").chars().take(300).collect::<String>()));
        return text("ok".into());
    }
    // /board/zmanim?lat=&lng=&elev=&tz=&date=YYYY-MM-DD: the engine's times for one day (see zmanim.rs).
    if let Some(q) = route(uri, "zmanim") {
        return jsn(zmanim::day_json(q));
    }
    // /board/geo: the location Windows knows (Settings > Privacy > Location). {"ok":false,"why":..} when it refuses.
    if route(uri, "geo").is_some() { return jsn(geo()) }
    // /board/apps: the installed ones of Otzaria and Zayit (their protocol's exe exists), e.g. ["zayit"].
    if route(uri, "apps").is_some() { return jsn(serde_json::to_string(&books::installed()).unwrap_or_default()) }
    // /board/book?app=zayit|otzaria&q=<json place>: the deep link to a day's portion, 404 when not found (see books.rs).
    if let Some(q) = route(uri, "book") {
        return match books::deep_link(&p(q, "app"), &p(q, "q")) {
            Some(u) => text(u),
            None => (b"not found".to_vec(), "text/plain".into(), 404),
        };
    }
    if let Some(q) = route(uri, "radio") { return jsn(radio::command_with(q, posted)) }
    if route(uri, "redalert").is_some() { return jsn(redalert::state()) }
    // /board/widgets?d={cardId: {big, sub, rows}}: the cards' summaries for their widgets (see widgets.rs).
    if let Some(q) = route(uri, "widgets") { widgets::push(&p(q, "d")); return text(widgets::take_goto()) } // answers the card a widget tap asked for, once
    // /board/startup?on=1|0: start the provider at sign-in (red alert needs the process up). Answers the state.
    if let Some(q) = route(uri, "startup") { return text(startup(http::query(q, "on").next().map(|v| v == "1"))) }
    // /board/sound?which=builtin|oref|windows: the settings' "listen" button.
    if let Some(q) = route(uri, "sound") { radio::alert_sound(&p(q, "which"), p(q, "v").parse().ok()); return text("ok".into()) }
    // The red alert's "קריאה בקול" sample (a fixed sentence: the page cannot make it say anything else).
    if let Some(q) = route(uri, "speak") {
        let v = p(q, "v").parse().ok();
        std::thread::spawn(move || radio::speak("ירי רקטות וטילים. בני ברק, רמת גן. זמן להגיע למרחב מוגן: דקה וחצי", v));
        return text("ok".into())
    }
    if route(uri, "report").is_some() { return jsn(report()) }
    // The own places of the pinned widgets of a kind (shabbat.js computes a summary for each).
    // Google sign-in for the YouTube subscriptions, per account (ytlogin.rs).
    if let Some(q) = route(uri, "ytlogin") { let (b, t, st) = ytlogin::route(&p(q, "do"), &p(q, "acc")); return (b, t, st as _) }
    if let Some(q) = route(uri, "customs") { return jsn(serde_json::json!(widgets::customs(&p(q, "k"))).to_string()) }
    if route(uri, "metered").is_some() { return text(if metered() { "1" } else { "0" }.into()) }
    if route(uri, "accent").is_some() { return text(accent()) }
    if let Some(q) = route(uri, "update") {
        if let Some(a) = http::query(q, "auto").next() { update::set_auto(a == "1"); }
        match http::query(q, "do").next().as_deref() {
            Some("check") => update::check(false, false),
            Some("install") => { std::thread::spawn(|| update::check(true, true)); }
            _ => {}
        }
        return jsn(update::status());
    }
    // /board/settings?d=<json>: the page's settings, kept on disk so the widgets and the background work see them.
    if let Some(q) = route(uri, "settings") {
        let d = p(q, "d");
        let f = data_dir().join("settings.json");
        if post && d.is_empty() { return (b"bad".to_vec(), "text/plain".into(), 400) }
        if !d.is_empty() {
            if serde_json::from_str::<serde_json::Value>(&d).is_err() || d.len() > 2_000_000 { return (b"bad".to_vec(), "text/plain".into(), 400) }
            let _ = std::fs::create_dir_all(data_dir());
            let _ = std::fs::write(&f, d.as_bytes());
            widgets::settings_changed();
        }
        return jsn(std::fs::read_to_string(&f).unwrap_or_else(|_| "{}".into()));
    }
    // /board/open?u=<https url or otzaria:// zayit://>: outside the board (its web view would keep it inside).
    if let Some(q) = route(uri, "open") {
        let url = p(q, "u");
        if !(url.starts_with("https://") || url.starts_with("otzaria://") || url.starts_with("zayit://")) { return (b"bad url".to_vec(), "text/plain".into(), 400) }
        let w = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let r = unsafe { ShellExecuteW(core::ptr::null_mut(), w("open").as_ptr(), w(&url).as_ptr(), core::ptr::null(), core::ptr::null(), 1) };
        return (vec![], "text/plain".into(), if r as usize > 32 { 200 } else { 500 });
    }
    // /board/notify?via=toast|board|both&id=&title=&body=&url=
    if let Some(q) = route(uri, "notify") {
        let via = p(q, "via");
        if quiet_now(0) { return (b"quiet".to_vec(), "text/plain".into(), 200) }
        // One store with the background checks (bg.rs): an id already sent goes out no more. Not the tests from Settings.
        let id = p(q, "id");
        let dedupe = !id.is_empty() && !id.starts_with("test-");
        if dedupe && notify::seen(&id) { return (b"dup".to_vec(), "text/plain".into(), 200) }
        let mut errs = Vec::new();
        if via != "board" { if let Err(e) = notify::toast(&p(q, "title"), &p(q, "body"), &p(q, "url"), "", "") { errs.push(format!("toast {e}")); } }
        if via == "board" || via == "both" { if let Err(e) = notify::announce(&p(q, "id"), &p(q, "title"), &p(q, "body")) { errs.push(format!("board {e}")); } }
        if !errs.is_empty() { log(&format!("notify: {}", errs.join("; "))); } else if dedupe { notify::mark(&id); }
        return (errs.join("; ").into_bytes(), "text/plain; charset=utf-8".into(), if errs.is_empty() { 200 } else { 500 });
    }
    // /board/schedule?d={"plan":[...],"quiet":[[a,b],...]}: the notifications Windows shows on time (see notify::schedule).
    if let Some(q) = route(uri, "schedule") {
        // An empty or broken d (a POST body request_body dropped) is an error: quiet.json, the scheduled
        // notifications and plan-at.txt stay as they are.
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&p(q, "d")) else { return (b"bad".to_vec(), "text/plain".into(), 400) };
        if !v.is_object() { return (b"bad".to_vec(), "text/plain".into(), 400) }
        let quiet: Vec<(i64, i64)> = v["quiet"].as_array().into_iter().flatten().filter_map(|w| Some((w[0].as_i64()?, w[1].as_i64()?))).collect();
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(data_dir().join("quiet.json"), serde_json::to_string(&quiet).unwrap_or_default());
        return match notify::schedule(&v["plan"], &quiet) {
            Ok(n) => text(n.to_string()),
            Err(e) => { log(&format!("schedule: {e}")); (e.message().into_bytes(), "text/plain; charset=utf-8".into(), 500) }
        };
    }
    // /board/proxy?u=<url>[&m=POST&t=<type>][&h=<Name: value>]... (the body POSTed, or &b=<body>): sources that refuse cross-origin reads.
    // A station's packaged logo (radio.js LOGOS): Images/stations/<id>.png beside the exe.
    if let Some(q) = route(uri, "station") {
        let id = p(q, "id");
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return (b"bad id".to_vec(), "text/plain".into(), 400) }
        let png = std::env::current_exe().ok().and_then(|e| std::fs::read(e.with_file_name("Images").join("stations").join(format!("{id}.png"))).ok());
        return match png { Some(b) => (b, "image/png".into(), 200), None => (b"no logo".to_vec(), "text/plain".into(), 404) };
    }
    if let Some(q) = route(uri, "proxy") {
        let url = p(q, "u");
        if !url.starts_with("https://") && !url.starts_with("http://") { return (b"bad url".to_vec(), "text/plain".into(), 400) }
        let method = http::query(q, "m").next().unwrap_or_else(|| "GET".into());
        // HEAD: the podcasts card asks whether a YouTube video is open under NetFree (200) or blocked (418).
        if !matches!(method.as_str(), "GET" | "POST" | "HEAD") { return (b"method".to_vec(), "text/plain".into(), 405) }
        // The body: the POST's own (the page sends it so), else `&b=` in the address (older callers).
        let body = if !posted.is_empty() { posted.to_string() } else { p(q, "b") };
        let mut headers: String = http::query(q, "h").map(|h| h + "\r\n").collect();
        if let Some(t) = http::query(q, "t").next() { headers += &format!("Content-Type: {t}\r\n"); }
        // &nr=1: no redirect followed; the answer is 200 with "<status> <Location>" (the YouTube card's Shorts check:
        // shorts/<id> of a regular video redirects to /watch). A 3xx itself would make the page follow it.
        if p(q, "nr") == "1" {
            return match http::fetch_plain(&method, &url, &headers, body.as_bytes()) {
                Some((r, raw)) => {
                    let loc = raw.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("location")).map(|(_, v)| v.trim().to_string())).unwrap_or_default();
                    (format!("{} {loc}", r.status).into_bytes(), "text/plain".into(), 200)
                }
                None => (b"fetch failed".to_vec(), "text/plain".into(), 502),
            };
        }
        let got =if method == "GET" || p(q, "c") == "1" {
            // A posted body is not in the address: put it in the cache key, or two bodies would share one answer.
            let key = if posted.is_empty() { q.to_string() } else { format!("{q}&b={posted}") };
            match http::cached(&key, move || http::fetch(&method, &url, &headers, body.as_bytes())) {
                Some(r) => Some(r),
                None => return (b"pending".to_vec(), "text/plain".into(), 425),
            }
        } else { http::fetch(&method, &url, &headers, body.as_bytes()).map(std::sync::Arc::new) };
        return match got {
            Some(r) => (r.body.clone(), r.content_type.clone(), r.status as i32),
            None => (b"fetch failed".to_vec(), "text/plain".into(), 502),
        };
    }
    // ponytail: one page for every other path under /board/; split assets out only if the page grows past one file.
    (PAGE.as_bytes().to_vec(), "text/html; charset=utf-8".into(), 200)
}

#[interface("00000001-0000-0000-C000-000000000046")]
unsafe trait IClassFactory: IUnknown {
    fn CreateInstance(&self, outer: *mut c_void, iid: *const GUID, out: *mut *mut c_void) -> HRESULT;
    fn LockServer(&self, lock: BOOL) -> HRESULT;
}

#[implement(IClassFactory)]
struct Factory {
    widgets: bool,
}

impl IClassFactory_Impl for Factory_Impl {
    unsafe fn CreateInstance(&self, outer: *mut c_void, iid: *const GUID, out: *mut *mut c_void) -> HRESULT {
        unsafe {
            *out = core::ptr::null_mut();
            if !outer.is_null() { return HRESULT(0x80040110u32 as i32) } // CLASS_E_NOAGGREGATION
            if self.widgets {
                let p: IWidgetProvider = widgets::Provider::new().into();
                return p.query(iid, out);
            }
            let p: IFeedProvider = Provider.into();
            p.query(iid, out)
        }
    }
    unsafe fn LockServer(&self, _lock: BOOL) -> HRESULT { HRESULT(0) }
}

/// The media flyout names the app from the process's AppUserModelID. A COM server started by the board may have
/// no app identity of its own (no window, no activation as an app): it shows "Unknown app". Set it to the package's
/// Application (PackageFamilyName!App, as in AppxManifest.xml; the dev and the release packages differ, so at run time).
fn set_aumid() {
    const APP_ID: &str = "App";
    let read = |f: unsafe extern "system" fn(*mut u32, *mut u16) -> i32| -> Option<String> {
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        (unsafe { f(&mut len, buf.as_mut_ptr()) } == 0).then(|| String::from_utf16_lossy(&buf[..len.saturating_sub(1) as usize]))
    };
    let own = read(GetCurrentApplicationUserModelId);
    let id = match (&own, read(GetCurrentPackageFamilyName)) {
        (Some(a), _) => a.clone(),
        (None, Some(f)) => format!("{f}!{APP_ID}"),
        (None, None) => { log("aumid: not packaged"); return }
    };
    let w: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(w.as_ptr()) };
    log(&format!("aumid: {id} (own: {}, set: {hr:?})", own.as_deref().unwrap_or("none")));
}

/// The app's Start menu entry runs the same exe as the startup task and the board's COM activation. The board
/// passes -RegisterProcessAsComServer; the other two differ only in the activation kind (Launch or StartupTask).
/// Only a Launch is a Start menu launch: no activation info (a dev run of the bare exe) stays the provider.
fn start_menu_launch(args: &[String]) -> bool {
    if args.iter().skip(1).any(|a| a.eq_ignore_ascii_case("-RegisterProcessAsComServer") || a.eq_ignore_ascii_case("-Embedding")) {
        log("activation: com");
        return false;
    }
    let kind = AppInstance::GetActivatedEventArgs().and_then(|a| a.Kind());
    log(&format!("activation: {}", match &kind { Ok(k) => k.0.to_string(), Err(e) => format!("none ({})", e.message()) }));
    kind == Ok(ActivationKind::Launch)
}

/// The app has no window of its own: the Start menu entry opens the widgets board and this process exits (the board
/// starts the provider by COM when it needs it). ms-widgetboard: is the protocol of the board (WidgetBoard.exe);
/// ms-widgets: starts the old Widgets.exe, which shows nothing here. The board opens on its last page: no launch
/// word was found that selects a feed ("dashboard?dashboardid=<feed id>" shows the board, not this feed).
fn open_board() {
    let w = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let r = unsafe { ShellExecuteW(core::ptr::null_mut(), w("open").as_ptr(), w("ms-widgetboard:").as_ptr(), core::ptr::null(), core::ptr::null(), 1) };
    log(&format!("start menu: opened the board ({})", r as usize));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Dev aid: haluach-widget.exe --zmanim "lat=..&lng=..&date=.." prints the engine's day as JSON.
    if let Some(i) = args.iter().position(|a| a == "--zmanim") {
        println!("{}", zmanim::day_json(args.get(i + 1).map(String::as_str).unwrap_or("")));
        return;
    }
    // Dev aid: haluach-widget.exe --book zayit|otzaria '<json>' prints the deep link; with no json, one json a line on stdin.
    // Dev aid: --apps prints the installed ones.
    if let Some(i) = args.iter().position(|a| a == "--widgets") { widgets::dump(args.get(i + 1).map(String::as_str).unwrap_or("widgets-cards.json"), args.get(i + 2).map(String::as_str)); return }
    // Dev aid: --bg-once [data folder] prints the weather and rates summaries the background refresher would write.
    // Dev aid: --shipments-once <data folder> prints what the shipments round would send and push (no toast, no writes).
    if let Some(i) = args.iter().position(|a| a == "--shipments-once") { shipments::once(args.get(i + 1).map(String::as_str)); return }
    if let Some(i) = args.iter().position(|a| a == "--plan-once") { notify::plan_once(args.get(i + 1).map(String::as_str)); return }
    if let Some(i) = args.iter().position(|a| a == "--bg-once") { bg::once(args.get(i + 1).map(String::as_str)); return }
    // A reminder's "קראתי" button (haluach-done: protocol, AppxManifest.xml): cancel, log and exit.
    if let Some(u) = args.iter().skip(1).find(|a| a.trim_matches('"').starts_with("haluach-done:")) {
        log(&format!("done {u}: {:?}", notify::done(u).map_err(|e| e.message())));
        return;
    }
    // Dev aid: --speak "<Hebrew text>" [volume] reads it aloud as a red alert would (radio::speak).
    if let Some(i) = args.iter().position(|a| a == "--speak") {
        radio::speak(args.get(i + 1).map(String::as_str).unwrap_or("בדיקה"), args.get(i + 2).and_then(|v| v.parse().ok()));
        std::thread::sleep(std::time::Duration::from_secs(8));
        return;
    }
    // Dev aid: --depr <lat> <lng> <yyyy-mm-dd> <degrees> <rise|set>: the unix ms of that depression (itim tuning).
    if let Some(i) = args.iter().position(|a| a == "--depr") {
        let g = |k: usize| args.get(i + k).cloned().unwrap_or_default();
        let d: Vec<i64> = g(3).split('-').filter_map(|x| x.parse().ok()).collect();
        let day = zmanim::days_from_civil(d[0], d[1], d[2]);
        let t = zmanim::at_depression(day, g(1).parse().unwrap_or(0.0), g(2).parse().unwrap_or(0.0), g(4).parse().unwrap_or(0.0), g(5) == "rise");
        println!("{}", t.map(|t| ((t * 1000.0) as i64).to_string()).unwrap_or("-".into()));
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--buses") { buses::once(args.get(i + 1).map(String::as_str).unwrap_or(".")); return }
    if args.iter().any(|a| a == "--apps") { println!("{:?}", books::installed()); return }
    if let Some(i) = args.iter().position(|a| a == "--book") {
        let app = args.get(i + 1).cloned().unwrap_or_default();
        let one = |q: &str| println!("{}	{}", books::deep_link(&app, q).unwrap_or_else(|| "-".into()), q);
        match args.get(i + 2) {
            Some(q) => one(q),
            None => for l in std::io::stdin().lines().map_while(Result::ok) { one(l.trim()) },
        }
        return;
    }
    unsafe {
        CoInitializeEx(core::ptr::null(), 0).ok().ok(); // COINIT_MULTITHREADED
        log("process start");
        if start_menu_launch(&args) { open_board(); return }
        set_aumid();
        let guid = |s: &str| GUID::from_u128(u128::from_str_radix(&s.replace('-', ""), 16).unwrap_or(0));
        let feed: IUnknown = Factory { widgets: false }.into();
        let wid: IUnknown = Factory { widgets: true }.into();
        let (mut c1, mut c2) = (0u32, 0u32);
        // 4 = CLSCTX_LOCAL_SERVER, 1 = REGCLS_MULTIPLEUSE. One process serves the board page and the widgets.
        let ok1 = CoRegisterClassObject(&guid(CLSID), feed.as_raw(), 4, 1, &mut c1).is_ok();
        let ok2 = CoRegisterClassObject(&guid(WCLSID), wid.as_raw(), 4, 1, &mut c2).is_ok();
        if !ok1 && !ok2 { return }
        update::start();
        redalert::start();
        forums::start();
        bg::start();
        shipments::start();
        podcasts::start();
        youtube::start();
        buses::start();
        // ponytail: never signalled; the board starts us on demand and Windows ends us with the session.
        let ev = CreateEventW(core::ptr::null(), BOOL(1), BOOL(0), core::ptr::null());
        let mut idx = 0u32;
        let _ = CoWaitForMultipleObjects(0, u32::MAX, 1, &ev, &mut idx);
    }
}

fn geo() -> String {
    let r = (|| -> windows_core::Result<(f64, f64, f64)> {
        let access = Geolocator::RequestAccessAsync()?.join()?;
        if access != GeolocationAccessStatus::Allowed { return Err(windows_core::Error::from_hresult(HRESULT(0x80070005u32 as i32))) }
        let g = Geolocator::new()?;
        let p = g.GetGeopositionAsync()?.join()?.Coordinate()?;
        let pos = p.Point()?.Position()?;
        Ok((pos.Latitude, pos.Longitude, p.Accuracy()?))
    })();
    match r {
        Ok((lat, lng, acc)) => serde_json::json!({ "ok": true, "lat": lat, "lng": lng, "accuracy": acc }).to_string(),
        Err(e) => { log(&format!("geo: {e}")); serde_json::json!({ "ok": false, "why": e.message() }).to_string() }
    }
}

/// The StartupTask (manifest "HaLuachStartup"). Windows may refuse (the user turned it off in Task Manager):
/// the answer says so ("DisabledByUser" etc.).
fn startup(on: Option<bool>) -> String {
    let r = (|| -> windows_core::Result<StartupTaskState> {
        let t = StartupTask::GetAsync(&HSTRING::from("HaLuachStartup"))?.join()?;
        match on {
            Some(true) => t.RequestEnableAsync()?.join(),
            Some(false) => { t.Disable()?; t.State() }
            None => t.State(),
        }
    })();
    match r { Ok(s) => format!("{}", s.0), Err(e) => { log(&format!("startup: {e}")); format!("error {}", e.message()) } }
}

fn metered() -> bool {
    (|| -> windows_core::Result<bool> {
        let c = NetworkInformation::GetInternetConnectionProfile()?.GetConnectionCost()?;
        let t = c.NetworkCostType()?;
        Ok(t == NetworkCostType::Fixed || t == NetworkCostType::Variable || c.Roaming()? || c.OverDataLimit()?)
    })().unwrap_or(false)
}

fn accent() -> String {
    let v = reg("HKCU\\Software\\Microsoft\\Windows\\DWM", "AccentColor").and_then(|h| u32::from_str_radix(h.trim_start_matches("0x"), 16).ok());
    v.map(|v| format!("#{:02X}{:02X}{:02X}", v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff)).unwrap_or_default()
}

fn reg(key: &str, name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("reg").args(["query", key, "/v", name]).creation_flags(0x0800_0000).output().ok()?;
    let out = String::from_utf8_lossy(&out.stdout).to_string();
    let line = out.lines().find(|l| l.trim_start().starts_with(name))?;
    line.split_whitespace().nth(2).map(str::to_string)
}

fn report() -> String {
    let nt = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    let build = match (reg(nt, "CurrentBuild"), reg(nt, "UBR").and_then(|u| u32::from_str_radix(u.trim_start_matches("0x"), 16).ok())) {
        (Some(b), Some(u)) => format!("{b}.{u}"),
        (Some(b), None) => b,
        _ => String::new(),
    };
    let log = std::fs::read_to_string(std::env::temp_dir().join("haluach.log")).unwrap_or_default();
    let lines: Vec<&str> = log.lines().collect();
    let tail: Vec<String> = lines[lines.len().saturating_sub(40)..].iter().map(|l| l.chars().take(200).collect()).collect();
    serde_json::json!({ "build": build, "log": tail.join("\n") }).to_string()
}
