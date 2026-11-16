// "ערוצי יוטיוב": Google sign-in to read a user's subscriptions (youtube.com/feed/channels), as HaFeed's login.rs.
// Several accounts: each one has its own Edge profile (yt-profiles/<n>) and its own cookies.
//  1. A plain Edge window, NO DevTools port (Google refuses to sign in with the port open: "this browser may not be
//     secure"). The user signs in and closes the window.
//  2. The same profile, headless, with the port: the youtube.com cookies over DevTools (Storage.getCookies), checked
//     on feed/channels, then Edge closes.
// The cookies are kept encrypted with DPAPI (only this Windows user can read them), never logged, and sent only to
// www.youtube.com. The page parses the subscriptions page itself (youtube.js parseSavedPage).
use crate::{data_dir, forums::{dpapi, edge_path}, http, log};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SUBS: &str = "https://www.youtube.com/feed/channels?hl=iw&gl=IL";

// ---------- the cookies: account -> Cookie header value ----------
static JAR: Mutex<Option<BTreeMap<String, String>>> = Mutex::new(None);
fn with_jar<R>(f: impl FnOnce(&mut BTreeMap<String, String>) -> R) -> R {
    let mut g = JAR.lock().unwrap();
    let m = g.get_or_insert_with(|| {
        std::fs::read(data_dir().join("yt-accounts.dat")).ok().and_then(|b| dpapi(&b, false)).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    });
    f(m)
}
fn save(m: &BTreeMap<String, String>) {
    let Ok(text) = serde_json::to_vec(m) else { return };
    if let Some(enc) = dpapi(&text, true) {
        let _ = std::fs::create_dir_all(data_dir());
        let _ = std::fs::write(data_dir().join("yt-accounts.dat"), enc);
    }
}
fn profile(acc: &str) -> std::path::PathBuf { data_dir().join("yt-profiles").join(acc) }

#[derive(Clone, PartialEq)]
enum Run { Pending, Failed(String) }
static RUNS: Mutex<BTreeMap<String, Run>> = Mutex::new(BTreeMap::new());

/// The route `ytlogin?do=...&acc=<n>` (n: digits only, chosen by the page). Returns (body, type, status).
pub fn route(what: &str, acc: &str) -> (Vec<u8>, String, u16) {
    let txt = |s: &str, st: u16| (s.as_bytes().to_vec(), "text/plain; charset=utf-8".to_string(), st);
    if what != "status" && (acc.is_empty() || acc.len() > 4 || !acc.bytes().all(|b| b.is_ascii_digit())) { return txt("bad acc", 400) }
    match what {
        "start" => { start(acc.to_string()); txt("ok", 200) }
        "status" => (status().into_bytes(), "application/json".into(), 200),
        // The subscriptions page, for the page to parse. 401: not signed in (any more); 502: no answer (not a
        // reason to sign in again).
        "subs" => match with_jar(|j| j.get(acc).cloned()).map(|c| subs_page(&c)) {
            Some(Ok(html)) => (html.into_bytes(), "text/html; charset=utf-8".into(), 200),
            Some(Err(true)) => txt("no answer", 502),
            _ => txt("signed out", 401),
        },
        "logout" => {
            with_jar(|j| { j.remove(acc); save(j); });
            RUNS.lock().unwrap().remove(acc);
            let _ = std::fs::remove_dir_all(profile(acc));
            txt("ok", 200)
        }
        _ => txt("bad do", 400),
    }
}

fn status() -> String {
    // The runs first, then the jar: a sign-in that ends in between is seen as pending, then signed (never neither).
    let runs = RUNS.lock().unwrap();
    let signed: Vec<String> = with_jar(|j| j.keys().cloned().collect());
    let pending: Vec<&String> = runs.iter().filter(|(_, r)| **r == Run::Pending).map(|(a, _)| a).collect();
    let failed: BTreeMap<&String, &String> = runs.iter().filter_map(|(a, r)| if let Run::Failed(e) = r { Some((a, e)) } else { None }).collect();
    json!({ "signed": signed, "pending": pending, "failed": failed }).to_string()
}

fn start(acc: String) {
    {
        let mut runs = RUNS.lock().unwrap();
        if runs.get(&acc) == Some(&Run::Pending) { return }
        runs.insert(acc.clone(), Run::Pending);
    }
    std::thread::spawn(move || {
        let r = run(&acc);
        let mut runs = RUNS.lock().unwrap();
        match r {
            Ok(cookie) => {
                // Signed first, then no longer pending: a status read in between must not see neither.
                with_jar(|j| { j.insert(acc.clone(), cookie); save(j); });
                runs.remove(&acc);
                log(&format!("youtube: account {acc} signed in"));
            }
            Err(e) => { log(&format!("youtube: account {acc} sign-in failed: {e}")); runs.insert(acc, Run::Failed(e)); }
        }
    });
}

fn run(acc: &str) -> Result<String, String> {
    let edge = edge_path().ok_or("Microsoft Edge לא נמצא במחשב")?;
    let prof = profile(acc);
    let login = format!("https://accounts.google.com/ServiceLogin?service=youtube&continue={}", "https%3A%2F%2Fwww.youtube.com%2Ffeed%2Fchannels");
    // Step 1: plain, no DevTools port.
    let mut win = std::process::Command::new(&edge)
        .arg(format!("--user-data-dir={}", prof.display()))
        .args(["--no-first-run", "--no-default-browser-check"])
        .arg(format!("--app={login}"))
        .spawn().map_err(|_| "Edge לא נפתח".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(900);
    // Closed = the process ended, or its window is gone for a few seconds (Edge may keep running in the background
    // after its last window closes, and then the process never ends).
    let pid = win.id();
    let (mut seen, mut gone) = (false, 0);
    loop {
        if let Ok(Some(_)) = win.try_wait() { break }
        if has_window(pid) { seen = true; gone = 0 } else if seen { gone += 1; if gone >= 5 { let _ = win.kill(); break } }
        if Instant::now() > deadline { let _ = win.kill(); return Err("עבר הזמן להתחברות".into()) }
        std::thread::sleep(Duration::from_millis(700));
    }
    // ponytail: wait for the profile's other Edge processes to let go of the cookie store.
    std::thread::sleep(Duration::from_millis(1500));
    // Step 2: headless, read the cookies.
    let port_file = prof.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);
    let mut child = std::process::Command::new(&edge)
        .arg(format!("--user-data-dir={}", prof.display()))
        .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "about:blank"])
        .spawn().map_err(|_| "Edge לא נפתח".to_string())?;
    let mut result = Err("לא נמצאה התחברות. מתחברים בחלון, מחכים שדף המינויים ייפתח, ורק אז סוגרים.".to_string());
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(500));
        let Ok(s) = std::fs::read_to_string(&port_file) else { continue };
        let mut l = s.lines();
        let (Some(p), Some(path)) = (l.next(), l.next()) else { continue };
        let Ok(port) = p.trim().parse::<u16>() else { continue };
        let Some(reply) = http::ws_roundtrip(port, path.trim(), r#"{"id":1,"method":"Storage.getCookies"}"#) else { continue };
        let cookie = youtube_cookies(&reply);
        if !cookie.is_empty() && subs_page(&cookie).is_ok() { result = Ok(cookie); }
        let _ = http::ws_roundtrip(port, path.trim(), r#"{"id":2,"method":"Browser.close"}"#);
        break;
    }
    std::thread::sleep(Duration::from_millis(500));
    let _ = child.kill();
    result
}

/// Does this process own a visible top-level window?
fn has_window(pid: u32) -> bool {
    type Proc = unsafe extern "system" fn(isize, isize) -> i32;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(f: Proc, l: isize) -> i32;
        fn GetWindowThreadProcessId(h: isize, pid: *mut u32) -> u32;
        fn IsWindowVisible(h: isize) -> i32;
    }
    unsafe extern "system" fn each(h: isize, l: isize) -> i32 {
        let st = unsafe { &mut *(l as *mut (u32, bool)) };
        let mut p = 0u32;
        unsafe { GetWindowThreadProcessId(h, &mut p) };
        if p == st.0 && unsafe { IsWindowVisible(h) } != 0 { st.1 = true; return 0 }
        1
    }
    let mut st = (pid, false);
    unsafe { EnumWindows(each, &mut st as *mut _ as isize) };
    st.1
}

/// The youtube.com cookies of a Storage.getCookies reply, as a Cookie header value.
fn youtube_cookies(reply: &str) -> String {
    let v: Value = serde_json::from_str(reply).unwrap_or_default();
    v["result"]["cookies"].as_array().into_iter().flatten()
        .filter(|c| { let d = c["domain"].as_str().unwrap_or("").trim_start_matches('.'); d == "youtube.com" || d == "www.youtube.com" })
        .filter_map(|c| Some(format!("{}={}", c["name"].as_str()?, c["value"].as_str()?)))
        .collect::<Vec<_>>().join("; ")
}

/// The subscriptions page with these cookies, if they are signed in (the page's own flag in its config).
/// Outside the shared cookie jar and without redirects (fetch_plain): the session must not leak into the page's
/// proxy, nor mix with another account's. Err(true) = no answer at all, Err(false) = signed out (a redirect too).
fn subs_page(cookie: &str) -> Result<String, bool> {
    let (r, _) = http::fetch_plain("GET", SUBS, &format!("Cookie: {cookie}\r\nAccept-Language: he\r\n"), b"").ok_or(true)?;
    let body = String::from_utf8_lossy(&r.body).into_owned();
    if r.status == 200 && body.contains("\"LOGGED_IN\":true") { Ok(body) } else { Err(false) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn cookies() {
        let j = r#"{"id":1,"result":{"cookies":[{"name":"SID","value":"a","domain":".youtube.com"},{"name":"G","value":"x","domain":".google.com"},{"name":"P","value":"1","domain":"www.youtube.com"}]}}"#;
        assert_eq!(super::youtube_cookies(j), "SID=a; P=1");
    }
}
