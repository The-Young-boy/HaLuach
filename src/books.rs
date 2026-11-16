// /board/book?app=zayit|otzaria&q={"b":title,"t":[headings],"r":ref,"a":alt}: the deep link that opens a day's portion
// in the app (SPEC "קישורים לאוצריא ולזית"). Both apps keep the same seforim.db layout (book, tocEntry/tocText, line):
// the book by its title, its TOC headings each under the one before (or an alternative TOC, e.g. the Yerushalmi's
// Vilna dapim), then the first line whose reference is `r` or starts it. Read only; the answers are kept per DB file.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Where the app keeps its seforim.db now, found again on every call (an update or a move changes it).
pub fn db_path(app: &str) -> Option<PathBuf> {
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty()).map(PathBuf::from);
    let mut c: Vec<PathBuf> = Vec::new();
    match app {
        // Zayit (kdroidFilter): $SEFORIMAPP_DATABASE_PATH, else FileKit's databases dir
        "zayit" => {
            c.extend(env("SEFORIMAPP_DATABASE_PATH"));
            c.extend(env("APPDATA").map(|d| d.join("io.github.kdroidfilter.seforimapp").join("databases").join("seforim.db")));
        }
        // Otzaria: the folders its installer records in the data root, then the defaults (per user, then system wide).
        // The data root is %APPDATA%\otzaria, or otzaria_data beside a portable exe.
        "otzaria" => {
            let mut roots: Vec<PathBuf> = env("APPDATA").map(|d| d.join("otzaria")).into_iter().collect();
            let exe = handler("otzaria");
            if let Some(dir) = exe.as_ref().and_then(|e| e.parent()) {
                roots.push(dir.join("otzaria_data"));
            }
            for r in &roots {
                for f in ["library_database_path.txt", "library_path.txt"] {
                    if let Ok(s) = std::fs::read_to_string(r.join(f)) {
                        let d = PathBuf::from(s.trim_start_matches('\u{feff}').trim());
                        c.push(d.join("seforim.db"));
                        c.push(d.join("אוצריא").join("seforim.db"));
                    }
                }
                c.push(r.join("books").join("seforim.db"));
            }
            c.extend(env("ProgramData").map(|d| d.join("otzaria").join("books").join("seforim.db")));
            if let Some(dir) = exe.as_ref().and_then(|e| e.parent()) {
                c.push(dir.join("אוצריא").join("seforim.db"));
                c.push(dir.join("seforim.db"));
            }
        }
        _ => {}
    }
    c.into_iter().find(|p| p.is_file())
}

const HKCU: isize = 0x8000_0001u32 as i32 as isize;
const HKLM: isize = 0x8000_0002u32 as i32 as isize;
#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegGetValueW(key: isize, sub: *const u16, value: *const u16, flags: u32, ty: *mut u32, data: *mut u16, len: *mut u32) -> i32;
}

/// A key's default string (reg.exe would garble a Hebrew path in its code page).
fn reg_default(root: isize, sub: &str) -> Option<String> {
    let w: Vec<u16> = sub.encode_utf16().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    // 0x2 = RRF_RT_REG_SZ
    let r = unsafe { RegGetValueW(root, w.as_ptr(), core::ptr::null(), 0x2, core::ptr::null_mut(), buf.as_mut_ptr(), &mut len) };
    if r != 0 { return None }
    let n = (len as usize / 2).saturating_sub(1).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

/// The exe that opens `<app>://` (HKCU, then HKLM), when the command names one that exists. An uninstall may leave
/// the key behind (Otzaria on this PC: its key names an exe that is gone).
pub fn handler(app: &str) -> Option<PathBuf> {
    let key = format!("Software\\Classes\\{app}\\shell\\open\\command");
    [HKCU, HKLM].iter().find_map(|&root| {
        let cmd = reg_default(root, &key)?;
        let cmd = cmd.trim();
        let exe = match cmd.strip_prefix('"') {
            Some(rest) => rest.split('"').next()?.to_string(),
            None => { let i = cmd.to_lowercase().find(".exe")?; cmd[..i + 4].to_string() }
        };
        Some(PathBuf::from(exe)).filter(|p| p.is_file())
    })
}

/// The learning links' apps that are installed, e.g. ["zayit"]: each only when its protocol's exe exists.
pub fn installed() -> Vec<&'static str> {
    ["otzaria", "zayit"].into_iter().filter(|a| handler(a).is_some()).collect()
}

/// The library's spelling, loosely: no niqqud, no quotes or geresh, single spaces. `loose` also drops yud and vav
/// (ביכורים / בכורים), for a title that is not found as is.
fn norm(s: &str, loose: bool) -> String {
    let t: String = s.chars()
        .filter(|c| !matches!(c, '\u{0591}'..='\u{05C7}' | '"' | '\'' | '׳' | '״'))
        .filter(|c| !(loose && matches!(c, 'י' | 'ו')))
        .collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct Place {
    pub book: i64,
    pub line_id: i64,
    pub line_index: i64,
}

fn open(path: &PathBuf) -> rusqlite::Result<Connection> {
    // The app may be open (WAL): a read-only connection. When the -shm can't be made, immutable (nothing changes then).
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    let uri = |q: &str| format!("file:///{}?{q}", path.to_string_lossy().replace('\\', "/").replace('%', "%25").replace('?', "%3f").replace('#', "%23"));
    let c = Connection::open_with_flags(uri("mode=ro"), flags)?;
    if c.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0)).is_ok() { return Ok(c) }
    Connection::open_with_flags(uri("immutable=1"), flags)
}

/// Finds the place in the DB at `path`. `q` = the page's JSON (see the top).
pub fn find(path: &PathBuf, q: &serde_json::Value) -> Option<Place> {
    let db = open(path).ok()?;
    let title = q["b"].as_str()?;
    let (book, real): (i64, String) = match db.query_row("SELECT id FROM book WHERE title = ?1 ORDER BY id LIMIT 1", [title], |r| r.get(0)).optional().ok()? {
        Some(id) => (id, title.to_string()),
        None => {
            let mut st = db.prepare("SELECT id, title FROM book ORDER BY id").ok()?;
            let all: Vec<(i64, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).ok()?.flatten().collect();
            [false, true].iter().find_map(|&loose| { let k = norm(title, loose); all.iter().find(|(_, t)| norm(t, loose) == k).cloned() })?
        }
    };
    let line_of = |id: i64| db.query_row("SELECT lineIndex FROM line WHERE id = ?1", [id], |r| r.get::<_, i64>(0)).ok();
    // The book's start, then its TOC headings
    let mut at: (i64, i64) = db.query_row("SELECT id, lineIndex FROM line WHERE bookId = ?1 ORDER BY lineIndex LIMIT 1", [book], |r| Ok((r.get(0)?, r.get(1)?))).ok()?;
    // A heading, or its alternatives (["דף ט.", "דף ט:"]: an edition without the amud)
    let heads: Vec<Vec<String>> = q["t"].as_array().map(|a| a.iter().map(|v| match v.as_array() {
        Some(alts) => alts.iter().filter_map(|x| x.as_str().map(|s| norm(s, false))).collect(),
        None => v.as_str().map(|s| norm(s, false)).into_iter().collect(),
    }).collect()).unwrap_or_default();
    if !heads.is_empty() {
        let sql = match q["a"].as_str() {
            Some(_) => "SELECT e.id, e.parentId, t.text, e.lineId FROM alt_toc_entry e JOIN tocText t ON t.id = e.textId \
                        WHERE e.structureId = (SELECT id FROM alt_toc_structure WHERE bookId = ?1 AND key = ?2) ORDER BY e.id",
            None => "SELECT e.id, e.parentId, t.text, e.lineId FROM tocEntry e JOIN tocText t ON t.id = e.textId WHERE e.bookId = ?1 AND ?2 = ?2 ORDER BY e.id",
        };
        let mut st = db.prepare(sql).ok()?;
        let toc: Vec<(i64, Option<i64>, String, Option<i64>)> = st
            .query_map(rusqlite::params![book, q["a"].as_str().unwrap_or("")], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .ok()?.flatten().collect();
        let parent: HashMap<i64, Option<i64>> = toc.iter().map(|e| (e.0, e.1)).collect();
        // Under `p`: its child, or deeper (an edition may add a level between them)
        let under = |mut e: Option<i64>, p: i64| { while let Some(x) = e { if x == p { return true } e = parent.get(&x).copied().flatten(); } false };
        let mut cur: Option<i64> = None;
        let mut line = None;
        for h in &heads {
            let e = h.iter().find_map(|h| toc.iter().find(|e| norm(&e.2, false) == *h && cur.is_none_or(|p| under(e.1, p))))?;
            cur = Some(e.0);
            line = e.3;
        }
        let id = line?;
        at = (id, line_of(id)?);
    }
    // The line of its reference, from there on. Not there (the edition splits it otherwise): its perek or siman,
    // the reference without its last part, as long as more than the title is left.
    if let Some(r) = q["r"].as_str() {
        let has_ref = db.query_row("SELECT 1 FROM pragma_table_info('line') WHERE name = 'heRef'", [], |_| Ok(())).is_ok();
        if has_ref {
            // The title as the library spells it ("תהלים" -> "תהילים")
            let r = match r.strip_prefix(title) { Some(rest) if real != title => format!("{real}{rest}"), _ => r.to_string() };
            let mut st = db.prepare("SELECT id, lineIndex, heRef FROM line WHERE bookId = ?1 AND lineIndex >= ?2 AND heRef IS NOT NULL ORDER BY lineIndex").ok()?;
            let refs: Vec<(i64, i64, String)> = st.query_map(rusqlite::params![book, at.1], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))).ok()?
                .flatten().map(|(a, b, h)| (a, b, norm(&h, false))).collect();
            let mut r = norm(&r, false);
            let floor = norm(&real, false).len();
            loop {
                let pre = format!("{r},");
                if let Some(x) = refs.iter().find(|x| x.2 == r || x.2.starts_with(&pre)) { at = (x.0, x.1); break }
                match r.rfind(',') { Some(i) if i > floor => r.truncate(i), _ => break }
            }
        }
    }
    Some(Place { book, line_id: at.0, line_index: at.1 })
}

pub fn link(app: &str, p: &Place) -> String {
    match app {
        "zayit" => format!("zayit://book/{}/line/{}", p.book, p.line_id),
        _ => format!("otzaria://open/book/{}?index={}", p.book, p.line_index),
    }
}

/// The answer for (app, q): the deep link, or None (the page then uses the search link). Kept per DB file and its
/// size and time, so a new DB is asked again.
pub fn deep_link(app: &str, q: &str) -> Option<String> {
    static CACHE: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
    let path = db_path(app)?;
    let m = std::fs::metadata(&path).ok()?;
    let stamp = format!("{}|{}|{:?}|{}|{}", app, path.display(), m.modified().ok(), m.len(), q);
    if let Some(v) = CACHE.lock().ok()?.get_or_insert_with(HashMap::new).get(&stamp) { return v.clone() }
    let v: serde_json::Value = serde_json::from_str(q).ok()?;
    let out = find(&path, &v).map(|p| link(app, &p));
    if let Ok(mut c) = CACHE.lock() {
        let c = c.get_or_insert_with(HashMap::new);
        if c.len() > 500 { c.clear(); }
        c.insert(stamp, out.clone());
    }
    out
}
