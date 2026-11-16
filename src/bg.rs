// Background summaries for the widgets the page alone used to feed: "weather" and "rates".
// After a restart the page may stay closed for hours, so its summaries in widgets.json go stale. Once a minute
// after start and then every 30 minutes, a summary older than 45 minutes is computed here, in the page's format
// ({big, sub, rows: [[label, value, strong?]], at}) and with its texts (web/src/cards/weather.js and rates.js,
// `widget()`). The page's push still wins when it is newer (widgets::push compares `at`).
// Nothing goes out on shabbat or yom tov (crate::quiet_now, the page's windows).
use crate::{http, log, widgets};
use serde_json::{json, Value};
use std::time::Duration;

const STALE_MS: i64 = 45 * 60_000;
const UA: &str = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) HaLuach\r\n";
const KINDS: [&str; 2] = ["weather", "rates"];

fn now_ms() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0) }

pub fn start() {
    start_alerts();
    std::thread::spawn(|| {
        // The widget updates go through COM (as the widgets' own clock thread).
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        std::thread::sleep(Duration::from_secs(60));
        let mut topped = 0i64;
        loop {
            tick();
            // Once a day: the zmanim reminders, when the page has not planned them for a while (notify::top_up_zmanim).
            let day = now_ms() / 86_400_000;
            if day != topped {
                topped = day;
                match crate::notify::top_up_zmanim() { Ok(0) => {} Ok(n) => log(&format!("bg: zmanim top-up {n}")), Err(e) => log(&format!("bg: zmanim top-up {e}")) }
            }
            std::thread::sleep(Duration::from_secs(30 * 60));
        }
    });
}

/// Weather alerts (rain in the next hour, IMS warnings, air quality/dust) also when the board page is closed:
/// every 15 minutes, the same rules, texts and ids as weather.js alerts(). The page sends through /board/notify,
/// which shares the sent-ids store (notify::seen/mark), so each alert goes out once from either side.
fn start_alerts() {
    std::thread::spawn(|| {
        let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
        std::thread::sleep(Duration::from_secs(2 * 60));
        loop {
            alert_tick();
            std::thread::sleep(Duration::from_secs(15 * 60));
        }
    });
}

fn alert_tick() {
    if crate::quiet_now(0) { return }
    let st = widgets::settings_value();
    // settings.notify.weather (planner.js NOTIFY default: on).
    if st["notify"]["weather"].as_bool() == Some(false) { return }
    for (id, title, body) in weather_alerts(&st) {
        if crate::notify::seen(&id) { continue }
        match crate::notify::toast(&title, &body, "", "", "") {
            Ok(()) => { crate::notify::mark(&id); log(&format!("bg: alert {id}")); }
            Err(e) => log(&format!("bg: alert toast {e}")),
        }
    }
}

/// weather.js alerts(data, s): [(id, title, body)] for the alerts the user turned on. No fetch when none is on.
fn weather_alerts(st: &Value) -> Vec<(String, String, String)> {
    let s = card_settings(st, "weather", json!({}));
    let mut a = json!({ "rain": false, "rainMm": 0.2, "ims": false, "air": false, "aqi": 101, "dust": 150 });
    if let (Some(o), Some(u)) = (a.as_object_mut(), s["alerts"].as_object()) { for (k, v) in u { o.insert(k.clone(), v.clone()); } }
    let on = |k: &str| a[k].as_bool().unwrap_or(false);
    let il = st["loc"]["il"].as_bool().unwrap_or(false);
    if !on("rain") && !(on("ims") && il) && !on("air") { return vec![] }
    let Some(raw) = fetch_weather(st) else { return vec![] };
    let place = st["loc"]["name"].as_str().unwrap_or("");
    let cur = raw.om["current"]["time"].as_str().unwrap_or("");
    let mut out = vec![];
    if on("rain") {
        if let (Some(r), Some(min)) = (rain_next(&raw.om), a["rainMm"].as_f64()) {
            if r >= min && cur.len() >= 13 {
                let at = if place.is_empty() { String::new() } else { format!(" ב{place}") };
                out.push((format!("weather-rain-{}", &cur[..13]), "גשם בשעה הקרובה".into(), format!("צפויים {} מ\"מ{at}.", js_num(r))));
            }
        }
    }
    if on("ims") && il {
        for it in raw.warnings.as_deref().map(|x| blocks(x, "item")).unwrap_or_default() {
            let g = strip(tag(it, "guid"));
            let id = if g.is_empty() { strip(tag(it, "link")) + &strip(tag(it, "pubDate")) } else { g };
            let t = strip(tag(it, "title"));
            out.push((format!("weather-ims-{id}"), if t.is_empty() { "אזהרת השירות המטאורולוגי".into() } else { t }, strip(tag(it, "description"))));
        }
    }
    if on("air") {
        if let Some(c) = raw.aq.as_ref().map(|q| &q["current"]).filter(|c| c.is_object()) {
            let aqi = c["us_aqi"].as_f64();
            let dust = c["dust"].as_f64();
            let bad = matches!((aqi, a["aqi"].as_f64()), (Some(v), Some(t)) if v >= t);
            let dusty = matches!((dust, a["dust"].as_f64()), (Some(v), Some(t)) if v >= t);
            if (bad || dusty) && cur.len() >= 10 {
                let aqi_s = aqi.map(js_num).unwrap_or_else(|| "null".into());
                let text = aqi.map(|v| aqi_text(round(v))).unwrap_or("");
                let d = dust.map(|d| format!(", אבק {} מק\"ג/מ\"ק", round(d))).unwrap_or_default();
                out.push((format!("weather-air-{}", &cur[..10]), if dusty { "אובך ואבק" } else { "איכות אוויר ירודה" }.into(),
                    format!("מדד איכות אוויר {aqi_s} ({text}){d}.")));
            }
        }
    }
    out
}

fn tick() {
    if crate::quiet_now(0) { return }
    let d = widgets::current();
    // Weather widgets set to another place (התאמה אישית): each place on its own, as stale as the main one.
    for c in widgets::customs("weather") {
        let at = d["weather"]["per"][&c]["at"].as_i64().unwrap_or(0);
        if now_ms() - at >= STALE_MS { refresh_place(&c); }
    }
    for kind in KINDS {
        // Only for a widget the user pinned; the page feeds its own cards.
        if !widgets::has_kind(kind) { continue }
        let at = d[kind]["at"].as_i64().unwrap_or(0);
        if now_ms() - at < STALE_MS { continue }
        match compute(kind) {
            Some(v) => {
                log(&format!("bg: {kind} refreshed (page summary {} min old)", if at > 0 { ((now_ms() - at) / 60_000).to_string() } else { "missing".into() }));
                widgets::push(&json!({ kind: v }).to_string());
            }
            None => log(&format!("bg: {kind} failed")),
        }
    }
}

/// The weather for one widget's own place (its CustomState {"name","lat","lng"}), into data.weather.per.
pub fn refresh_place(custom: &str) {
    let _ = unsafe { crate::CoInitializeEx(core::ptr::null(), 0) };
    let Ok(p) = serde_json::from_str::<Value>(custom) else { return };
    let mut st = widgets::settings_value();
    // IMS (Israel's max/min and warnings) only for a place inside Israel's rough box.
    let il = matches!((p["lat"].as_f64(), p["lng"].as_f64()), (Some(la), Some(ln)) if (29.4..=33.4).contains(&la) && (34.2..=35.95).contains(&ln));
    st["loc"] = json!({ "name": p["name"].as_str().unwrap_or("").split(',').next().unwrap_or(""), "lat": p["lat"], "lng": p["lng"], "il": il });
    match weather(&st) {
        Some(mut v) => { v["at"] = json!(now_ms()); widgets::set_per("weather", custom, v); }
        None => log("bg: weather for a widget's place failed"),
    }
}

/// The widget's "רענון": one summary ("weather" or "rates") now, whatever its age.
pub fn refresh(kind: &str) {
    match compute(kind) {
        Some(v) => widgets::push(&json!({ kind: v }).to_string()),
        None => log(&format!("bg: {kind} refresh failed")),
    }
}

fn compute(kind: &str) -> Option<Value> {
    let st = widgets::settings_value();
    let mut v = match kind { "weather" => weather(&st)?, _ => rates(&st)? };
    v["at"] = json!(now_ms());
    Some(v)
}

/// Dev aid (haluach-widget.exe --bg-once [data folder]): both summaries and the weather alerts as JSON, nothing written.
pub fn once(folder: Option<&str>) {
    if let Some(f) = folder { widgets::set_dir(f); }
    let out: serde_json::Map<String, Value> = KINDS.iter().map(|k| (k.to_string(), compute(k).unwrap_or(Value::Null))).collect();
    let mut out = out;
    // The weather alerts the 15-minute check would send now (nothing sent, the store not touched).
    let al: Vec<Value> = weather_alerts(&widgets::settings_value()).into_iter()
        .map(|(id, t, b)| json!({ "id": id, "title": t, "body": b, "seen": crate::notify::seen(&id) })).collect();
    out.insert("alerts".into(), json!(al));
    println!("{}", serde_json::to_string_pretty(&Value::Object(out)).unwrap_or_default());
}

fn get_json(url: &str) -> Option<Value> {
    let r = http::fetch("GET", url, UA, b"")?;
    if r.status != 200 { log(&format!("bg: {} {}", r.status, url.split('?').next().unwrap_or(""))); return None }
    serde_json::from_slice(&r.body).ok()
}
fn get_text(url: &str) -> Option<String> {
    let r = http::fetch("GET", url, UA, b"")?;
    (r.status == 200).then(|| String::from_utf8_lossy(&r.body).into_owned())
}

/// The card settings as the page sees them: its defaults, then the user's (a shallow merge, as cardSettings).
fn card_settings(st: &Value, id: &str, defaults: Value) -> Value {
    let mut s = defaults;
    if let (Some(o), Some(u)) = (s.as_object_mut(), st["cards"][id].as_object()) { for (k, v) in u { o.insert(k.clone(), v.clone()); } }
    s
}

// ---------- formatting as JS does ----------
/// Math.round: half up.
fn round(v: f64) -> i64 { (v + 0.5).floor() as i64 }
/// deg(): Math.round(v) + '°'.
fn deg(v: Option<f64>) -> String { v.map(|v| format!("{}°", round(v))).unwrap_or_else(|| "-".into()) }
/// A JS number as text (Rust's shortest form matches it for the values here: 0.2, 1, 12.5).
fn js_num(v: f64) -> String { if v.fract() == 0.0 { format!("{}", v as i64) } else { format!("{v}") } }
/// toLocaleString('he-IL', { min = max = d fraction digits }): ',' groups, '.' decimals.
fn fmt(v: f64, d: usize) -> String {
    let s = format!("{:.*}", d, v.abs());
    let (int, frac) = s.split_once('.').map(|(a, b)| (a.to_string(), Some(b.to_string()))).unwrap_or((s.clone(), None));
    let mut g = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 { g.push(','); }
        g.push(c);
    }
    format!("{}{}{}", if v < 0.0 { "-" } else { "" }, g, frac.map(|f| format!(".{f}")).unwrap_or_default())
}
fn digits(v: f64) -> usize { if v >= 1000.0 { 0 } else if v >= 10.0 { 2 } else if v >= 0.1 { 3 } else { 5 } }
fn pct_text(c: Option<f64>) -> String { c.map(|c| format!(" ({}{:.2}%)", if c > 0.0 { "+" } else { "" }, c)).unwrap_or_default() }

// ---------- weather (weather.js: fetchAll, model, widget) ----------
/// WMO code -> the Hebrew text of weather-icons.js wmo().
fn wmo(c: i64) -> &'static str {
    match c {
        0 => "בהיר", 1 => "בהיר בעיקר", 2 => "מעונן חלקית", 3 => "מעונן", 45 | 48 => "ערפל",
        51..=57 => "טפטוף", 61..=64 => "גשם", 65..=67 => "גשם חזק", 71..=77 => "שלג", 80..=82 => "ממטרים",
        85 | 86 => "ממטרי שלג", c if c >= 95 => "סופות רעמים", _ => "",
    }
}
fn aqi_text(v: i64) -> &'static str {
    if v <= 50 { "טובה" } else if v <= 100 { "סבירה" } else if v <= 150 { "לא בריאה לרגישים" } else if v <= 200 { "לא בריאה" } else { "מסוכנת" }
}
fn dir_text(deg: f64) -> &'static str {
    const DIRS: [&str; 8] = ["צפון", "צפון-מזרח", "מזרח", "דרום-מזרח", "דרום", "דרום-מערב", "מערב", "צפון-מערב"];
    DIRS[(round(((deg % 360.0) + 360.0) % 360.0 / 45.0) as usize) % 8]
}
/// "YYYY-MM-DDTHH:MM" + minutes (the strings are already local; no time zone math), as weather.js plus().
fn plus(t: &str, min: i64) -> String {
    let n = |a: usize, b: usize| t.get(a..b).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let days = crate::zmanim::days_from_civil(n(0, 4), n(5, 7), n(8, 10));
    let total = days * 1440 + n(11, 13) * 60 + n(14, 16) + min;
    let (d, m) = (total.div_euclid(1440), total.rem_euclid(1440));
    // civil from days (Howard Hinnant's algorithm)
    let z = d + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let mon = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mon <= 2 { 1 } else { 0 };
    format!("{y:04}-{mon:02}-{day:02}T{:02}:{:02}", m / 60, m % 60)
}

/// The text between `<t>` and `</t>`, trimmed.
fn tag<'a>(s: &'a str, t: &str) -> &'a str {
    let (o, c) = (format!("<{t}>"), format!("</{t}>"));
    s.find(&o).and_then(|a| { let r = &s[a + o.len()..]; r.find(&c).map(|b| r[..b].trim()) }).unwrap_or("")
}
/// Every `<t>...</t>` block.
fn blocks<'a>(s: &'a str, t: &str) -> Vec<&'a str> {
    let (o, c) = (format!("<{t}>"), format!("</{t}>"));
    let mut out = vec![];
    let mut rest = s;
    while let Some(a) = rest.find(&o) {
        let r = &rest[a + o.len()..];
        let Some(b) = r.find(&c) else { break };
        out.push(&r[..b]);
        rest = &r[b + c.len()..];
    }
    out
}
fn unent(s: &str) -> String {
    let mut s = s.to_string();
    while let Some(a) = s.find("<![CDATA[") {
        let Some(b) = s[a..].find("]]>") else { break };
        s = format!("{}{}{}", &s[..a], &s[a + 9..a + b], &s[a + b + 3..]);
    }
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|e| *e < 12);
        let ent = end.map(|e| &rest[1..e]);
        let ch = ent.and_then(|e| match e {
            "quot" => Some('"'), "apos" => Some('\''), "lt" => Some('<'), "gt" => Some('>'), "nbsp" => Some(' '), "amp" => Some('&'),
            _ if e.starts_with("#x") || e.starts_with("#X") => u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32),
            _ if e.starts_with('#') => e[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        });
        match (ch, end) {
            (Some(c), Some(e)) => { out.push(c); rest = &rest[e + 1..]; }
            _ => { out.push('&'); rest = &rest[1..]; }
        }
    }
    out.push_str(rest);
    out
}
/// strip(): entities, tags out, entities again, one space.
fn strip(s: &str) -> String {
    let mut no_tags = String::new();
    let mut inside = false;
    for c in unent(s).chars() {
        match c { '<' => { inside = true; no_tags.push(' ') } '>' if inside => inside = false, _ if !inside => no_tags.push(c), _ => {} }
    }
    unent(&no_tags).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The nearest IMS city's (max, min) for a date. The file is ISO-8859-8; only ASCII fields are read.
fn ims_day(xml: &str, lat: f64, lng: f64, date: &str) -> Option<(f64, f64)> {
    let km = |a: f64, b: f64| {
        let r = std::f64::consts::PI / 180.0;
        let (dl, dg) = ((a - lat) * r, (b - lng) * r);
        let x = (dl / 2.0).sin().powi(2) + (lat * r).cos() * (a * r).cos() * (dg / 2.0).sin().powi(2);
        12742.0 * x.sqrt().asin()
    };
    let loc = blocks(xml, "Location").into_iter().filter_map(|l| {
        let (a, b) = (tag(l, "DisplayLat").parse::<f64>().ok()?, tag(l, "DisplayLon").parse::<f64>().ok()?);
        Some((km(a, b), l))
    }).min_by(|a, b| a.0.total_cmp(&b.0))?.1;
    let tu = blocks(loc, "TimeUnitData").into_iter().find(|t| tag(t, "Date") == date)?;
    let el = |name: &str| blocks(tu, "Element").into_iter().find(|e| tag(e, "ElementName") == name).and_then(|e| tag(e, "ElementValue").parse::<f64>().ok());
    Some((el("Maximum temperature")?, el("Minimum temperature")?))
}

/// The raw answers, as weather.js fetchAll(): Open-Meteo forecast, air quality, IMS cities and warnings (Israel only).
struct Raw { om: Value, aq: Option<Value>, cities: Option<String>, warnings: Option<String>, lat: f64, lng: f64 }

fn fetch_weather(st: &Value) -> Option<Raw> {
    let loc = &st["loc"];
    let (lat, lng) = (loc["lat"].as_f64()?, loc["lng"].as_f64()?);
    let il = loc["il"].as_bool().unwrap_or(false);
    let q = format!("latitude={lat}&longitude={lng}&timezone=auto");
    let om = get_json(&format!("https://api.open-meteo.com/v1/forecast?{q}&forecast_days=7&wind_speed_unit=kmh\
        &current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m,uv_index\
        &minutely_15=precipitation&hourly=temperature_2m,weather_code,precipitation_probability,is_day\
        &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max"))?;
    let aq = get_json(&format!("https://air-quality-api.open-meteo.com/v1/air-quality?{q}&current=us_aqi,pm10,pm2_5,dust"));
    let cities = if il { get_text("https://ims.gov.il/sites/default/files/ims_data/xml_files/isr_cities.xml") } else { None };
    let warnings = if il { get_text("https://ims.gov.il/sites/default/files/ims_data/rss/alert/rssAlert_general_country_he.xml") } else { None };
    Some(Raw { om, aq, cities, warnings, lat, lng })
}

/// Rain in the next hour (mm, one decimal): the 15-minute precipitation after now, up to an hour (as model()).
fn rain_next(om: &Value) -> Option<f64> {
    let cur = om["current"]["time"].as_str()?;
    let until = plus(cur, 60);
    let m = &om["minutely_15"];
    let mut sum = 0.0;
    for (i, t) in m["time"].as_array().into_iter().flatten().enumerate() {
        if let Some(t) = t.as_str() { if t > cur && t <= until.as_str() { sum += m["precipitation"][i].as_f64().unwrap_or(0.0); } }
    }
    Some((sum * 10.0).round() / 10.0)
}

fn weather(st: &Value) -> Option<Value> {
    if st["loc"]["lat"].as_f64().is_none() || st["loc"]["lng"].as_f64().is_none() {
        return Some(json!({ "big": "", "sub": "בחרו מיקום בלוח", "rows": [] }));
    }
    let name = st["loc"]["name"].as_str().unwrap_or("");
    let Raw { om, aq, cities, warnings, lat, lng } = fetch_weather(st)?;
    let c = &om["current"];
    let cur = c["time"].as_str()?;
    let (hh, dd) = (&om["hourly"], &om["daily"]);
    let htimes: Vec<&str> = hh["time"].as_array()?.iter().filter_map(Value::as_str).collect();
    let hour0 = format!("{}:00", cur.get(..13)?);
    let start = htimes.iter().position(|t| *t >= hour0.as_str()).unwrap_or(0);
    // The hours from now: (time, temp, rain chance).
    let hour = |i: usize| -> Option<(&str, Option<f64>, Option<i64>)> {
        let j = start + i;
        Some((*htimes.get(j)?, hh["temperature_2m"][j].as_f64(), hh["precipitation_probability"][j].as_f64().map(round)))
    };
    let date0 = dd["time"][0].as_str();
    let mut day0 = date0.map(|_| (dd["temperature_2m_max"][0].as_f64(), dd["temperature_2m_min"][0].as_f64()));
    // In Israel the IMS city forecast wins for the day's max/min (as model()).
    if let (Some(x), Some(d)) = (&cities, date0) {
        if let Some((mx, mn)) = ims_day(x, lat, lng, d) { day0 = Some((Some(mx), Some(mn))); }
    }
    let rain0 = dd["precipitation_probability_max"][0].as_f64().map(round);
    let rain_next = rain_next(&om).unwrap_or(0.0);

    let mut rows = vec![];
    if let Some((mx, mn)) = day0 { rows.push(json!(["היום", format!("{} / {}", deg(mx), deg(mn)), true])); }
    for i in [3, 6, 9, 12] {
        if let Some((t, temp, rain)) = hour(i) {
            let r = rain.filter(|r| *r >= 20).map(|r| format!(" · {r}%")).unwrap_or_default();
            rows.push(json!([t.get(11..16).unwrap_or(""), deg(temp) + &r]));
        }
    }
    if let Some(r) = rain0 {
        rows.push(json!(["סיכוי לגשם", format!("{r}%{}", if rain_next > 0.0 { format!(" ({} מ\"מ בשעה)", js_num(rain_next)) } else { String::new() })]));
    }
    if let Some(w) = c["wind_speed_10m"].as_f64() {
        rows.push(json!(["רוח", format!("{} קמ\"ש {}", round(w), dir_text(c["wind_direction_10m"].as_f64().unwrap_or(0.0)))]));
    }
    if let Some(a) = aq.as_ref().and_then(|a| a["current"]["us_aqi"].as_f64()) {
        let a = round(a);
        rows.push(json!(["איכות אוויר", format!("{a} ({})", aqi_text(a))]));
    }
    if let Some(x) = &warnings {
        if let Some(it) = blocks(x, "item").first() {
            let t = strip(tag(it, "title"));
            rows.push(json!(["אזהרה", if t.is_empty() { "אזהרת השירות המטאורולוגי".to_string() } else { t }, true]));
        }
    }
    let text = wmo(c["weather_code"].as_i64().unwrap_or(-1));
    let sub = format!("{text} · {name}");
    let sub = sub.strip_suffix(" · ").unwrap_or(&sub).to_string();
    Some(json!({ "big": deg(c["temperature_2m"].as_f64()), "sub": sub, "rows": rows }))
}

// ---------- rates (rates.js: fetchAll, widgetSummary) ----------
fn fiat_name(code: &str) -> String {
    match code {
        "USD" => "דולר", "EUR" => "יורו", "GBP" => "לירה שטרלינג", "JPY" => "יין", "CHF" => "פרנק שוויצרי", "CAD" => "דולר קנדי",
        "AUD" => "דולר אוסטרלי", "JOD" => "דינר ירדני", "EGP" => "לירה מצרית",
        // Intl.DisplayNames('he') for the rest of the Bank of Israel's list.
        "DKK" => "כתר דני", "NOK" => "כתר נורווגי", "SEK" => "כתר שוודי", "ZAR" => "ראנד דרום אפריקאי", "LBP" => "לירה לבנונית",
        _ => return code.to_string(),
    }.to_string()
}
fn crypto_name(id: &str) -> String {
    match id {
        "bitcoin" => "ביטקוין", "ethereum" => "אתריום", "solana" => "סולנה", "ripple" => "ריפל", "tether" => "טת'ר",
        "litecoin" => "לייטקוין", "dogecoin" => "דוג'קוין", "cardano" => "קרדנו", _ => return id.to_string(),
    }.to_string()
}

fn rates(st: &Value) -> Option<Value> {
    let s = card_settings(st, "rates", json!({ "fiat": ["USD", "EUR"], "crypto": ["bitcoin"] }));
    let list = |k: &str| -> Vec<String> { s[k].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(str::to_string)).collect() };
    let (fiat, crypto) = (list("fiat"), list("crypto"));
    // BOI: code -> (shekels per unit, change %, unit).
    let boi: std::collections::HashMap<String, (f64, Option<f64>, f64)> = get_json("https://boi.org.il/PublicApi/GetExchangeRates")
        .map(|j| j["exchangeRates"].as_array().into_iter().flatten().filter_map(|r| {
            let unit = r["unit"].as_f64().filter(|u| *u != 0.0).unwrap_or(1.0);
            Some((r["key"].as_str()?.to_string(), (r["currentExchangeRate"].as_f64()? / unit, r["currentChange"].as_f64(), unit)))
        }).collect()).unwrap_or_default();
    let market = get_json("https://open.er-api.com/v6/latest/ILS");
    let mk = |c: &str| market.as_ref().and_then(|m| m["rates"][c].as_f64()).filter(|v| *v != 0.0).map(|v| 1.0 / v);
    let cg = if crypto.is_empty() { None } else {
        get_json(&format!("https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies=ils,usd&include_24hr_change=true", crypto.join(",")))
    };
    // As fetchAll: at least one source must answer.
    if boi.is_empty() && market.is_none() && cg.is_none() { return None }

    let mut rows = vec![];
    // One summary per item (widgetSummary's `per`), for a widget set to a single currency or coin.
    let mut per = serde_json::Map::new();
    let ch_text = |c: Option<f64>, when: &str| c.map(|c| format!(", {}{:.2}% {when}", if c > 0.0 { "+" } else { "" }, c)).unwrap_or_default();
    for c in &fiat {
        let b = boi.get(c);
        let Some(main) = b.map(|b| b.0 * b.2).or_else(|| mk(c)) else { continue };
        let name = format!("{}{}", b.filter(|b| b.2 > 1.0).map(|b| format!("{} ", js_num(b.2))).unwrap_or_default(), fiat_name(c));
        rows.push(json!([name, fmt(main, digits(main)) + &b.map(|b| pct_text(b.1)).unwrap_or_default()]));
        let sub = match b { Some(b) => format!("{name} יציג{}", ch_text(b.1, "היום")), None => format!("{name}, שער שוק") };
        let prow = match (b, mk(c)) { (Some(b), Some(m)) => json!([["שער שוק", fmt(m * b.2, digits(main))]]), _ => json!([]) };
        per.insert(c.clone(), json!({ "name": name, "big": format!("₪ {}", fmt(main, digits(main))), "sub": sub, "rows": prow, "at": now_ms() }));
    }
    for id in &crypto {
        let Some(ils) = cg.as_ref().and_then(|j| j[id]["ils"].as_f64()) else { continue };
        let change = cg.as_ref().and_then(|j| j[id]["ils_24h_change"].as_f64());
        rows.push(json!([crypto_name(id), format!("₪{}{}", fmt(ils, digits(ils)), pct_text(change))]));
        let prow = match cg.as_ref().and_then(|j| j[id]["usd"].as_f64()) { Some(u) => json!([["דולר", format!("${}", fmt(u, digits(u)))]]), None => json!([]) };
        per.insert(id.clone(), json!({ "name": crypto_name(id), "big": format!("₪ {}", fmt(ils, digits(ils))), "sub": format!("{}{}", crypto_name(id), ch_text(change, "ב-24 שעות")), "rows": prow, "at": now_ms() }));
    }
    let usd = boi.get("USD");
    let usd_v = usd.map(|u| u.0).or_else(|| mk("USD"));
    let sub = match (usd.and_then(|u| u.1), usd_v) {
        (Some(ch), _) => format!("דולר יציג, {}{:.2}% היום", if ch > 0.0 { "+" } else { "" }, ch),
        (None, Some(_)) => "דולר, שער שוק".into(),
        _ => "אין שער דולר".into(),
    };
    Some(json!({ "big": usd_v.map(|v| format!("$ {}", fmt(v, 3))).unwrap_or_default(), "sub": sub, "rows": rows, "per": per }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats() {
        assert_eq!(fmt(205808.4, 0), "205,808");
        assert_eq!(fmt(3.1995, 3), "3.200");
        assert_eq!(fmt(1234.5, 2), "1,234.50");
        assert_eq!(plus("2026-11-15T23:30", 60), "2026-11-16T00:30");
        assert_eq!(plus("2026-12-31T23:45", 15), "2027-01-01T00:00");
        assert_eq!(deg(Some(-0.4)), "0°");
        assert_eq!(pct_text(Some(-6.256)), " (-6.26%)");
        assert_eq!(strip("&#1488;<b>x</b>&amp;amp;"), "א x &");
        assert_eq!(dir_text(350.0), "צפון");
    }
}
