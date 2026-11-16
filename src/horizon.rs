// The visible sunrise and sunset (נץ / שקיעה הנראים): when the sun's upper edge clears the real horizon line.
// The horizon comes from Open-Meteo's elevation API (Copernicus DEM, 90 m, no key, 100 points per call): for every
// degree of azimuth where the sun can rise or set at this latitude, heights at distances from 0.5 to 60 km.
// Fetched once per place and kept in %LOCALAPPDATA%\HaLuach\horizon\<lat>_<lng>.json.
// "בניכוי N ק"מ" (עתים לבינה): terrain nearer than N km is ignored (a building or a nearby hill hides the sun only
// from part of the town).
use crate::zmanim::{at_depression, days_from_civil, horizon as std_horizon};
use serde_json::{json, Value};

const DISTS: [f64; 28] = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 23.0, 26.0, 30.0, 34.0, 38.0, 42.0, 46.0, 50.0, 54.0, 58.0, 62.0, 66.0];
const R_EARTH: f64 = 6_371_000.0;
const K_TERRESTRIAL: f64 = 0.13; // refraction of light along the ground

pub struct Profile {
    pub obs: f64,                         // the observer's ground height (m)
    pub az0: i32,                         // first azimuth (degrees from north)
    pub heights: Vec<Vec<f64>>,           // [azimuth][distance] terrain heights (m)
}

fn dest(lat: f64, lng: f64, az: f64, km: f64) -> (f64, f64) {
    let (p1, l1, b, d) = (lat.to_radians(), lng.to_radians(), az.to_radians(), km * 1000.0 / R_EARTH);
    let p2 = (p1.sin() * d.cos() + p1.cos() * d.sin() * b.cos()).asin();
    let l2 = l1 + (b.sin() * d.sin() * p1.cos()).atan2(d.cos() - p1.sin() * p2.sin());
    (p2.to_degrees(), l2.to_degrees())
}

/// The azimuths the sun rises at during the year here, with a margin: east = rising, west = setting.
fn az_range(lat: f64, rising: bool) -> (i32, i32) {
    // The solstice declinations give the extremes: cos(az) = sin(dec) / cos(lat).
    let c = (23.44f64.to_radians().sin() / lat.to_radians().cos()).clamp(-1.0, 1.0);
    let a = c.acos().to_degrees(); // azimuth of the summer extreme
    let (lo, hi) = (a.floor() as i32 - 3, (180.0 - a).ceil() as i32 + 3);
    if rising { (lo, hi) } else { (360 - hi, 360 - lo) }
}

fn cache_path(lat: f64, lng: f64, rising: bool) -> std::path::PathBuf {
    crate::data_dir().join("horizon").join(format!("{:.4}_{:.4}_{}.json", lat, lng, if rising { "e" } else { "w" }))
}

/// The terrain heights around the place (fetched once). None without a connection.
pub fn profile(lat: f64, lng: f64, rising: bool) -> Option<Profile> {
    let path = cache_path(lat, lng, rising);
    if let Some(v) = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        return Some(Profile { obs: v["obs"].as_f64()?, az0: v["az0"].as_i64()? as i32,
            heights: v["h"].as_array()?.iter().map(|r| r.as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default()).collect() });
    }
    let (a0, a1) = az_range(lat, rising);
    let mut pts = vec![(lat, lng)];
    for az in a0..=a1 { for d in DISTS { pts.push(dest(lat, lng, az as f64, d)); } }
    let mut hs = Vec::with_capacity(pts.len());
    for chunk in pts.chunks(100) {
        let la: Vec<String> = chunk.iter().map(|p| format!("{:.5}", p.0)).collect();
        let lo: Vec<String> = chunk.iter().map(|p| format!("{:.5}", p.1)).collect();
        let url = format!("https://api.open-meteo.com/v1/elevation?latitude={}&longitude={}", la.join(","), lo.join(","));
        // Open-Meteo allows 600 points a minute: pace the calls, and wait out a 429 (up to twice).
        let mut got = None;
        for _ in 0..3 {
            let Some(r) = crate::http::fetch("GET", &url, "", b"") else { crate::log("horizon: no reply"); return None };
            if r.status == 429 { std::thread::sleep(std::time::Duration::from_secs(62)); continue }
            got = Some(r);
            break;
        }
        let Some(r) = got else { return None };
        std::thread::sleep(std::time::Duration::from_millis(1200));
        if r.status != 200 { crate::log(&format!("horizon: {} {}", r.status, String::from_utf8_lossy(&r.body[..r.body.len().min(200)]))); return None }
        let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
        let Some(arr) = v["elevation"].as_array() else { crate::log("horizon: no heights in the reply"); return None };
        hs.extend(arr.iter().map(|x| x.as_f64().unwrap_or(0.0).max(0.0)));
    }
    if hs.len() != pts.len() { crate::log(&format!("horizon: {} heights for {} points", hs.len(), pts.len())); return None }
    let obs = hs[0];
    let heights: Vec<Vec<f64>> = hs[1..].chunks(DISTS.len()).map(|c| c.to_vec()).collect();
    let _ = std::fs::create_dir_all(path.parent()?);
    let _ = std::fs::write(&path, json!({ "obs": obs, "az0": a0, "h": heights }).to_string());
    Some(Profile { obs, az0: a0, heights })
}

/// The horizon's elevation angle (degrees, apparent) at azimuth `az`, ignoring terrain nearer than `skip_km`.
pub fn angle(p: &Profile, az: f64, eye: f64, skip_km: f64) -> f64 {
    let i = (az.round() as i32 - p.az0).clamp(0, p.heights.len() as i32 - 1) as usize;
    let h0 = p.obs + eye;
    let mut best = f64::MIN;
    for (j, d) in DISTS.iter().enumerate() {
        if *d < skip_km { continue }
        let dm = d * 1000.0;
        // The earth's curvature lowers far terrain; refraction along the ground lifts it back a little.
        let drop = dm * dm * (1.0 - K_TERRESTRIAL) / (2.0 * R_EARTH);
        let a = ((p.heights[i][j] - drop - h0) / dm).atan().to_degrees();
        if a > best { best = a; }
    }
    best
}

/// The sun at a moment: (apparent-free altitude of its centre, azimuth from north), degrees.
fn sun_alt_az(t: f64, lat: f64, lng: f64) -> (f64, f64) {
    let (dec, eq) = crate::zmanim::sun_dec_eq(t);
    let minutes_utc = t.rem_euclid(86400.0) / 60.0;
    let ha = ((minutes_utc + eq + 4.0 * lng) / 4.0 - 180.0).to_radians(); // hour angle
    let (la, de) = (lat.to_radians(), dec.to_radians());
    let alt = (la.sin() * de.sin() + la.cos() * de.cos() * ha.cos()).asin();
    let az = (-ha.sin()).atan2(de.tan() * la.cos() - la.sin() * ha.cos());
    (alt.to_degrees(), az.to_degrees().rem_euclid(360.0))
}

/// Refraction at apparent altitude `h` (degrees), Saemundsson, scaled like the plain horizon (pressure/temperature).
fn refraction(h: f64, scale: f64) -> f64 {
    scale * 1.02 / (h + 10.3 / (h + 5.11)).to_radians().tan() / 60.0
}

/// The profile only if it is already on disk; otherwise start fetching it in the background (it takes minutes:
/// Open-Meteo allows 600 points a minute) and answer None for now.
pub fn ready(lat: f64, lng: f64, rising: bool) -> bool {
    if cache_path(lat, lng, rising).exists() { return true }
    static BUSY: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let key = format!("{lat:.4}_{lng:.4}_{rising}");
    let mut b = BUSY.lock().unwrap();
    if !b.contains(&key) {
        b.push(key.clone());
        std::thread::spawn(move || { let _ = profile(lat, lng, rising); BUSY.lock().unwrap().retain(|k| k != &key); });
    }
    false
}

/// The visible sunrise (or sunset) on civil day `day`: unix seconds. None without a profile.
pub fn visible(day: i64, lat: f64, lng: f64, rising: bool, skip_km: f64) -> Option<f64> {
    let p = profile(lat, lng, rising)?;
    // The plain sunrise's depression gives this day's refraction scale (34' at the standard atmosphere).
    let scale = (std_horizon(day, lat, p.obs) - 16.0 / 60.0) / (34.0 / 60.0);
    let mut t = at_depression(day, lat, lng, std_horizon(day, lat, 0.0), rising)?;
    // Walk the sun along its path until its upper edge (apparent) is at the horizon line, then refine.
    let f = |t: f64| {
        let (alt, az) = sun_alt_az(t, lat, lng);
        let hz = angle(&p, az, 1.6, skip_km);
        alt + refraction(alt.max(-1.0), scale) + 16.0 / 60.0 - hz // > 0: visible
    };
    let step = if rising { 30.0 } else { -30.0 };
    // From the plain sunrise: if the edge is already visible, go back; else go forward.
    let up = f(t) > 0.0;
    let dir = if up == rising { -step } else { step };
    for _ in 0..240 {
        let n = t + dir;
        if (f(n) > 0.0) != up { t = n; break }
        t = n;
    }
    // Bisection inside the last 30 s.
    let (mut a, mut b) = (t - step.abs(), t + step.abs());
    for _ in 0..30 {
        let m = (a + b) / 2.0;
        let vis = f(m) > 0.0;
        if vis == rising { b = m } else { a = m }
    }
    Some((a + b) / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        let (a, b) = az_range(31.8, true);
        assert!(a > 50 && a < 65 && b > 115 && b < 130, "{a} {b}");
    }
    /// Needs the network. עתים לבינה, 13.11.26: Jerusalem visible sunrise (25 km) 06:04:45, Bnei Brak (1 km) 06:13:45.
    #[test]
    #[ignore]
    fn visible_vs_itim() {
        let day = days_from_civil(2026, 11, 13);
        for (name, lat, lng, km) in [("JLM", 31.7784, 35.2354, 25.0), ("BB", 32.0849, 34.8352, 1.0)] {
            let p = profile(lat, lng, true);
            eprintln!("{name} profile {:?}", p.as_ref().map(|p| (p.obs, p.az0, p.heights.len())));
            let t = visible(day, lat, lng, true, km).unwrap() as i64 + 2 * 3600;
            println!("{name} {:02}:{:02}:{:02}", t.rem_euclid(86400) / 3600, t / 60 % 60, t % 60);
        }
    }
}
