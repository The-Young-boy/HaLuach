// The zmanim engine (Rust, so the widgets and the scheduled notifications work without the board page).
// Solar events: the NOAA / Meeus formulas, iterated at the event time. The methods follow "עתים לבינה"
// (the calendar the public uses today; its tables are in research/itim):
//   "X במעלות"  = X minutes turned into a solar depression at the equinox in Jerusalem, then used all year.
//   "X בזמניות" = X minutes scaled by the length of the day (sunrise to sunset) over 12 hours.
//   "X שוות"    = X fixed minutes.
//   מישור = sea-level horizon (depression 0.833°). מהגובה = the place's elevation adds the dip of the horizon.
// All times are unix seconds (UTC); the caller formats them in its time zone.
use serde_json::{json, Map, Value};

const RAD: f64 = std::f64::consts::PI / 180.0;
/// Refraction (34') + the sun's half diameter (16'): the sun's centre below the horizon at sunrise.
pub const HORIZON: f64 = 0.833;
/// Jerusalem, for turning minutes into degrees (the equinox there).
const JLM: (f64, f64) = (31.7784, 35.2354);

/// Days since 1970-01-01 of a civil date (proleptic Gregorian).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The sun at a moment (unix seconds): (declination°, equation of time in minutes).
fn sun(t: f64) -> (f64, f64) {
    let jc = (t / 86400.0 + 2440587.5 - 2451545.0) / 36525.0;
    let l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)).rem_euclid(360.0);
    let m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    let e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    let c = (m * RAD).sin() * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + (2.0 * m * RAD).sin() * (0.019993 - 0.000101 * jc) + (3.0 * m * RAD).sin() * 0.000289;
    let lon = l0 + c;
    let omega = 125.04 - 1934.136 * jc;
    let app = lon - 0.00569 - 0.00478 * (omega * RAD).sin();
    let eps0 = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
    let eps = eps0 + 0.00256 * (omega * RAD).cos();
    let dec = ((eps * RAD).sin() * (app * RAD).sin()).asin() / RAD;
    let y = (eps / 2.0 * RAD).tan().powi(2);
    let eq = 4.0 / RAD * (y * (2.0 * l0 * RAD).sin() - 2.0 * e * (m * RAD).sin() + 4.0 * e * y * (m * RAD).sin() * (2.0 * l0 * RAD).cos()
        - 0.5 * y * y * (4.0 * l0 * RAD).sin() - 1.25 * e * e * (2.0 * m * RAD).sin());
    (dec, eq)
}

/// The sun's declination and the equation of time at a moment (for horizon.rs).
pub fn sun_dec_eq(t: f64) -> (f64, f64) { sun(t) }

/// Solar noon (transit) of the civil day `day` (days since 1970) at longitude `lng`, unix seconds.
pub fn noon(day: i64, lng: f64) -> f64 {
    let mut t = day as f64 * 86400.0 + (720.0 - 4.0 * lng) * 60.0;
    for _ in 0..3 {
        let (_, eq) = sun(t);
        t = day as f64 * 86400.0 + (720.0 - 4.0 * lng - eq) * 60.0;
    }
    t
}

/// The moment the sun's centre is `depr` degrees below the horizon, before noon (`rising`) or after it.
/// None when it never gets there that day (the far north in summer).
pub fn at_depression(day: i64, lat: f64, lng: f64, depr: f64, rising: bool) -> Option<f64> {
    let n = noon(day, lng);
    let mut t = n + if rising { -6.0 } else { 6.0 } * 3600.0;
    for _ in 0..5 {
        let (dec, eq) = sun(t);
        let cos_h = ((90.0 + depr) * RAD).cos() / ((lat * RAD).cos() * (dec * RAD).cos()) - (lat * RAD).tan() * (dec * RAD).tan();
        if !(-1.0..=1.0).contains(&cos_h) { return None }
        let h = cos_h.acos() / RAD; // hour angle in degrees
        let transit = day as f64 * 86400.0 + (720.0 - 4.0 * lng - eq) * 60.0;
        t = transit + if rising { -h } else { h } * 240.0;
    }
    Some(t)
}

/// The sun's centre below the horizon at sunrise for an observer `elev` metres up on civil day `day`:
/// refraction scaled by air pressure (from the height) and temperature (a seasonal climate curve), plus the
/// sun's half diameter. Fitted to עתים לבינה (tools/itim-check.py): with a fixed 34' the summer and the
/// mountain towns drift by up to half a minute.
pub fn horizon(day: i64, lat: f64, elev: f64) -> f64 { horizon_at(day, lat, elev, true) }
/// The same, for sunrise (`rising`) or sunset (the evening may be warmer).
pub fn horizon_at(day: i64, lat: f64, elev: f64, rising: bool) -> f64 {
    let p = 1010.0 * (1.0 - 2.25577e-5 * elev.max(0.0)).powf(5.25588); // hPa
    // Mean daily temperature: warmest at the end of July, coldest at the end of January (northern hemisphere).
    let doy = (day - days_from_civil(civil_from_days(day).0, 1, 1)) as f64;
    let phase = if rising { TEMP_PHASE } else { TEMP_PHASE_EVENING };
    let season = ((doy - phase) / 365.25 * 2.0 * std::f64::consts::PI).cos(); // 1 in late January
    let hemi = if lat >= 0.0 { 1.0 } else { -1.0 };
    let base = TEMP_BASE - TEMP_SLOPE * lat.abs() - TEMP_MID_COLD * (-((lat.abs() - 40.6) / 4.0).powi(2)).exp() + if rising { 0.0 } else { TEMP_EVENING }; // rough sea-level annual mean by latitude
    let t = base - TEMP_AMP * season * hemi - TEMP_LAPSE * elev.max(0.0);
    let refr = REFR_ARCMIN * (p / 1010.0) * (283.0 / (273.0 + t));
    refr / 60.0 + 16.0 / 60.0
}
pub const REFR_ARCMIN: f64 = 32.5;
/// The sea-level mean temperature model: TEMP_BASE - TEMP_SLOPE * |latitude| (°C).
pub const TEMP_BASE: f64 = 32.5;
pub const TEMP_SLOPE: f64 = 0.85;
/// The mid latitudes (around 40°, New York) are colder than the line through Israel and London: עתים לבינה's
/// New York day was ~10 s too short (sunrise late, sunset early, "במעלות" late in the morning) in every season.
/// A bump of -8 °C there (15.11.26): itim-check 2210 -> 2224, no key's max worse by more than 1 s.
pub const TEMP_MID_COLD: f64 = 8.0;
// Fitted (15.11.26, second pass) to every עתים לבינה row that is linear in netz and shkia: the netz/shkia
// seconds, "שוות" (20, 72) and the GRA hours, least squares on the site's half-minute centres.
// itim-check 2148 -> 2210 of 2335 rows; the sunset was ~5 s late in Israel and the far north too short a day.
pub const TEMP_AMP: f64 = 22.0;
/// The coldest day after 1 January (the climate lags the solstice).
pub const TEMP_PHASE: f64 = 25.0;
/// The evening is warmer than the morning (°C), so a little less refraction at sunset.
pub const TEMP_EVENING: f64 = 5.75;
/// The evening's coldest day after 1 January.
pub const TEMP_PHASE_EVENING: f64 = 35.0;
/// °C per metre up (the standard lapse rate).
pub const TEMP_LAPSE: f64 = 0.0065;

/// The dip of the horizon for an observer `h` metres up (degrees): 2.05' per √m, fitted to עתים לבינה "מהגובה".
pub fn dip(h: f64) -> f64 {
    if h <= 0.0 { 0.0 } else { 2.05 * h.sqrt() / 60.0 }
}

/// Minutes before sunrise (or after sunset) at the Jerusalem equinox, as a depression angle: "X במעלות".
/// The same angle is used everywhere (checked against עתים לבינה in London and New York too).
/// The equinox day the minutes-in-degrees angles are defined on (Jerusalem).
pub const EQUINOX: (i64, i64, i64) = (2026, 3, 20);
pub fn minutes_to_degrees(min: f64) -> f64 { minutes_to_degrees_at(min, true) }
/// The same, measured after sunset (`rising` false) for the evening times.
pub fn minutes_to_degrees_at(min: f64, _rising: bool) -> f64 {
    // The ideal equinox: the sun on the equator (declination 0) all day, so morning and evening are the same.
    // The hour angle at altitude -a for latitude L: cos H = -sin a / cos L; 1 degree of hour angle = 4 minutes.
    let lat = JLM.0 * RAD;
    let h0 = horizon(days_from_civil(EQUINOX.0, EQUINOX.1, EQUINOX.2), JLM.0, 0.0);
    let ha = |a: f64| (-(a * RAD).sin() / lat.cos()).acos() / RAD;
    let target = ha(h0) + min / 4.0;
    let (mut lo, mut hi) = (h0, 40.0);
    for _ in 0..60 {
        let mid = (lo + hi) / 2.0;
        if ha(mid) < target { lo = mid } else { hi = mid }
    }
    (lo + hi) / 2.0
}


/// One day at one place: every time the board and the widgets use, keyed by a stable id.
pub struct Day {
    pub t: Map<String, Value>,
}

pub fn compute(day: i64, lat: f64, lng: f64, elev: f64) -> Day {
    let mut t = Map::new();
    let mut put = |k: &str, v: Option<f64>| { t.insert(k.into(), v.map(|x| json!((x * 1000.0).round() as i64)).unwrap_or(Value::Null)); };
    let dep = |d: f64, r: bool| at_depression(day, lat, lng, d, r);
    let hz = horizon(day, lat, elev);
    let hz_set = horizon_at(day, lat, elev, false);
    let rise = dep(hz, true);
    let set = dep(hz_set, false);
    let rise_h = dep(hz + dip(elev), true);
    let set_h = dep(hz_set + dip(elev), false);
    put("sunrise", rise);
    put("sunset", set);
    put("sunrise_elev", rise_h);
    put("sunset_elev", set_h);
    put("chatzot", Some(noon(day, lng)));
    // Tonight's chatzot as עתים לבינה: the middle between the two noons around the night (their row for a date is
    // the night before it; tools/itim-check.py compares that).
    put("chatzot_night", Some((noon(day, lng) + noon(day + 1, lng)) / 2.0 + 43200.0));
    // "X במעלות" as עתים לבינה: the angle is measured from the day's own sunrise horizon (its refraction by season,
    // latitude and height), not from a fixed one. Fitted with tools/itim-fit.py.
    let shift = hz - horizon(days_from_civil(EQUINOX.0, EQUINOX.1, EQUINOX.2), JLM.0, 0.0);
    let deg = |min: f64| minutes_to_degrees(min) + shift;
    let deg_eve = |min: f64| minutes_to_degrees_at(min, false) + shift + (hz_set - hz);
    // Dawn
    for (k, d) in [("alot_90deg", deg(90.0)), ("alot_72deg", deg(72.0)), ("alot_120deg", deg(120.0)), ("alot_16_1", 16.1), ("alot_18", 18.0), ("alot_14", 14.0), ("alot_12", 12.0)] {
        put(k, dep(d, true));
    }
    for (k, d) in [("misheyakir_11_5", 11.5), ("misheyakir_13_5", 13.5), ("misheyakir_11", 11.0), ("misheyakir_10_5", 10.5), ("misheyakir_10_2", 10.2), ("misheyakir_8_5", 8.5)] {
        put(k, dep(d, true));
    }
    // Night
    for (k, d) in [("tzeit_6_45", 6.45), ("tzeit_4_2", 4.2), ("tzeit_5_071", 5.071), ("tzeit_6_15", 6.15), ("tzeit_7_05", 7.05), ("tzeit_7_083", 7.0833), ("tzeit_7_1", 7.1), ("tzeit_7_5", 7.5), ("tzeit_8", 8.0), ("tzeit_8_5", 8.5), ("tzeit_9_28", 9.28), ("tzeit_10_59", 10.59)] {
        put(k, dep(d, false));
    }
    for (k, min) in [("tzeit_geonim_18deg", 18.0), ("tzeit_geonim_13_5deg", 13.5), ("tzeit_geonim_16_875deg", 16.875), ("rt_72deg", 72.0), ("rt_90deg", 90.0), ("rt_120deg", 120.0)] {
        put(k, dep(deg_eve(min), false));
    }
    if let (Some(r), Some(s)) = (rise, set) {
        let hour = (s - r) / 12.0;
        let gra = |h: f64| Some(r + h * hour);
        put("shma_gra", gra(3.0));
        put("tefila_gra", gra(4.0));
        put("tevila_gra", gra(5.0));
        put("mincha_gedola_gra", gra(6.5));
        put("seuda_gra", gra(9.0));
        put("mincha_ketana_gra", gra(9.5));
        put("plag_gra", gra(10.75));
        // "בזמניות": minutes scaled by the day.
        let z = |min: f64| min * (s - r) / 43200.0; // minutes, scaled by the day (seconds / 12 h)
        put("alot_90zm", Some(r - z(90.0) * 60.0));
        put("alot_72zm", Some(r - z(72.0) * 60.0));
        put("rt_72zm", Some(s + z(72.0) * 60.0));
        put("tzeit_13_5zm", Some(s + z(13.5) * 60.0));
        // "שוות": fixed minutes.
        put("alot_90fix", Some(r - 5400.0));
        put("alot_72fix", Some(r - 4320.0));
        put("tzeit_20fix", Some(s + 1200.0));
        put("rt_72fix", Some(s + 4320.0));
        // Magen Avraham: the day from dawn to nightfall, in the variants the calendar prints.
        let mga = |a: Option<f64>, b: Option<f64>, h: f64| match (a, b) { (Some(a), Some(b)) => Some(a + h * (b - a) / 12.0), _ => None };
        let (a90, a72) = (dep(deg(90.0), true), dep(deg(72.0), true));
        let (n90, n72) = (dep(deg(90.0), false), dep(deg(72.0), false));
        put("shma_mga90", mga(a90, n90, 3.0));
        put("shma_mga72", mga(a72, n72, 3.0));
        put("tefila_mga90", mga(a90, n90, 4.0));
        put("tefila_mga72", mga(a72, n72, 4.0));
        // "לחומרא": from dawn (90 in degrees) to nightfall at 6.45°.
        let t645 = dep(6.45, false);
        put("shma_mga_chumra", mga(a90, t645, 3.0));
        put("tefila_mga_chumra", mga(a90, t645, 4.0));
        put("plag_mga_chumra", mga(a90, t645, 10.75));
    }
    // "חצות" for the hours of a day also kept as the later mincha gedola (half an hour after noon, or the zmani one).
    let n = noon(day, lng);
    put("mincha_gedola_30", Some(n + 1800.0));
    Day { t }
}

/// Query: lat, lng, elev (metres), date=YYYY-MM-DD. Answers {"date":..,"t":{id: unix ms}}.
pub fn day_json(q: &str) -> String {
    let get = |k: &str| crate::http::query(q, k).next().unwrap_or_default();
    let lat: f64 = get("lat").parse().unwrap_or(JLM.0);
    let lng: f64 = get("lng").parse().unwrap_or(JLM.1);
    let elev: f64 = get("elev").parse().unwrap_or(0.0);
    let date = get("date");
    let day = {
        let p: Vec<i64> = date.split('-').filter_map(|x| x.parse().ok()).collect();
        if p.len() == 3 { days_from_civil(p[0], p[1], p[2]) }
        else { (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) / 86400) as i64 }
    };
    let mut d = compute(day, lat, lng, elev);
    // The visible sunrise/sunset ("בניכוי N ק"מ", N from vis=), when the horizon profile is on disk already.
    let skip: f64 = get("vis").parse().unwrap_or(-1.0);
    if skip >= 0.0 {
        for (k, rising) in [("sunrise_vis", true), ("sunset_vis", false)] {
            let v = if crate::horizon::ready(lat, lng, rising) { crate::horizon::visible(day, lat, lng, rising, skip) } else { None };
            d.t.insert(k.into(), v.map(|x| json!((x * 1000.0).round() as i64)).unwrap_or(Value::Null));
        }
    }
    let (y, m, dd) = civil_from_days(day);
    json!({ "date": format!("{y:04}-{m:02}-{dd:02}"), "lat": lat, "lng": lng, "elev": elev, "t": d.t }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Israel winter time is UTC+2.
    fn hm(ms: &Value, off_h: i64) -> String {
        let s = ms.as_i64().unwrap() / 1000 + off_h * 3600;
        let s = s.rem_euclid(86400);
        format!("{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    }
    #[test]
    fn dates_roundtrip() {
        for z in [-1000, 0, 20000, 20770] { let (y, m, d) = civil_from_days(z); assert_eq!(days_from_civil(y, m, d), z); }
    }
    #[test]
    fn degrees_of_72_minutes_is_about_16_1() {
        let d = minutes_to_degrees(72.0);
        assert!((d - 16.1).abs() < 0.15, "{d}");
    }
    /// עתים לבינה, ירושלים, 13.11.2026 (research/itim). Only prints: the tuning is checked by tools/itim-check.
    #[test]
    fn jerusalem_print() {
        let d = compute(days_from_civil(2026, 11, 13), 31.7784, 35.2354, 754.0);
        for (k, v) in &d.t { if v.is_i64() { println!("{k:24} {}", hm(v, 2)); } }
    }
}
