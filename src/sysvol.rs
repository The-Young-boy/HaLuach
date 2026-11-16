// Red alert "even when the computer is muted" (cards.redalert.unmute): for the alert only, unmute the default
// output device and raise its master volume to a minimum, then put both back. Core Audio's IAudioEndpointVolume,
// declared here by hand (only the slots we call, in vtable order).
#![allow(non_snake_case)]

use core::ffi::c_void;
use std::sync::Mutex;
use windows_core::{GUID, HRESULT, IUnknown, Interface, interface};

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoCreateInstance(clsid: *const GUID, outer: *mut c_void, ctx: u32, iid: *const GUID, out: *mut *mut c_void) -> HRESULT;
}

#[interface("A95664D2-9614-4F35-A746-DE8DB63617E6")]
unsafe trait IMMDeviceEnumerator: IUnknown {
    fn EnumAudioEndpoints(&self, flow: i32, mask: u32, out: *mut *mut c_void) -> HRESULT;
    fn GetDefaultAudioEndpoint(&self, flow: i32, role: i32, out: *mut *mut c_void) -> HRESULT;
}

#[interface("D666063F-1587-4E43-81F1-B948E807363F")]
unsafe trait IMMDevice: IUnknown {
    fn Activate(&self, iid: *const GUID, ctx: u32, params: *const c_void, out: *mut *mut c_void) -> HRESULT;
}

#[interface("5CDF2C82-841E-4546-9722-0CF74078229C")]
unsafe trait IAudioEndpointVolume: IUnknown {
    fn RegisterControlChangeNotify(&self, n: *mut c_void) -> HRESULT;
    fn UnregisterControlChangeNotify(&self, n: *mut c_void) -> HRESULT;
    fn GetChannelCount(&self, n: *mut u32) -> HRESULT;
    fn SetMasterVolumeLevel(&self, db: f32, ctx: *const GUID) -> HRESULT;
    fn SetMasterVolumeLevelScalar(&self, v: f32, ctx: *const GUID) -> HRESULT;
    fn GetMasterVolumeLevel(&self, db: *mut f32) -> HRESULT;
    fn GetMasterVolumeLevelScalar(&self, v: *mut f32) -> HRESULT;
    fn SetChannelVolumeLevel(&self, ch: u32, db: f32, ctx: *const GUID) -> HRESULT;
    fn SetChannelVolumeLevelScalar(&self, ch: u32, v: f32, ctx: *const GUID) -> HRESULT;
    fn GetChannelVolumeLevel(&self, ch: u32, db: *mut f32) -> HRESULT;
    fn GetChannelVolumeLevelScalar(&self, ch: u32, v: *mut f32) -> HRESULT;
    fn SetMute(&self, mute: i32, ctx: *const GUID) -> HRESULT;
    fn GetMute(&self, mute: *mut i32) -> HRESULT;
}

const CLSID_ENUMERATOR: GUID = GUID::from_u128(0xBCDE0395_E52A_467C_8E3D_C4579291692E);
const CLSCTX_ALL: u32 = 0x17;

/// The default render endpoint's volume control (eRender, eConsole).
fn endpoint() -> Option<IAudioEndpointVolume> {
    unsafe {
        let _ = crate::CoInitializeEx(core::ptr::null(), 0);
        let mut p = core::ptr::null_mut();
        CoCreateInstance(&CLSID_ENUMERATOR, core::ptr::null_mut(), CLSCTX_ALL, &IMMDeviceEnumerator::IID, &mut p).ok().ok()?;
        let en = IMMDeviceEnumerator::from_raw(p);
        let mut d = core::ptr::null_mut();
        en.GetDefaultAudioEndpoint(0, 0, &mut d).ok().ok()?;
        let dev = IMMDevice::from_raw(d);
        let mut v = core::ptr::null_mut();
        dev.Activate(&IAudioEndpointVolume::IID, CLSCTX_ALL, core::ptr::null(), &mut v).ok().ok()?;
        Some(IAudioEndpointVolume::from_raw(v))
    }
}

/// What a boost changed: the levels from before the first boost, and what we set (to leave user changes alone).
/// `touched`: the user muted or changed the volume during the alert (seen by watch()); then the mute is not put back.
struct Saved { muted: bool, vol: f32, set: f32, holders: u32, touched: bool }
static SAVED: Mutex<Option<Saved>> = Mutex::new(None);

/// A pending restore. Overlapping boosts (the sound, then the speech) share one; the last apply() restores.
pub struct Restore(());

/// Unmutes the output and raises it to at least `min` (0..1). None when nothing could be read.
pub fn boost(min: f32) -> Option<Restore> {
    let ep = endpoint()?;
    let mut g = SAVED.lock().unwrap();
    unsafe {
        let (mut m, mut v) = (0i32, 0f32);
        ep.GetMute(&mut m).ok().ok()?;
        ep.GetMasterVolumeLevelScalar(&mut v).ok().ok()?;
        let min = min.clamp(0.0, 1.0);
        let set = v.max(min);
        if m != 0 { let _ = ep.SetMute(0, core::ptr::null()); }
        if set > v { let _ = ep.SetMasterVolumeLevelScalar(set, core::ptr::null()); }
        match &mut *g {
            Some(s) => { s.holders += 1; if set > s.set { s.set = set; } }
            None => {
                if m != 0 || set > v { crate::log(&format!("sysvol: boost (muted {}, {:.0}% -> {:.0}%)", m != 0, v * 100.0, set * 100.0)); }
                *g = Some(Saved { muted: m != 0, vol: v, set, holders: 1, touched: false });
                if m != 0 { std::thread::spawn(watch); }
            }
        }
    }
    Some(Restore(()))
}

/// While a boost that unmuted is held: a mute or a volume change by the user marks it `touched`. An unmute by the
/// user cannot be told from ours by the state alone, so a mute seen at any moment (mute, then unmute again) counts.
fn watch() {
    let Some(ep) = endpoint() else { return };
    loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let mut g = SAVED.lock().unwrap();
        let Some(s) = &mut *g else { return };
        if s.touched { return }
        let (mut m, mut v) = (0i32, 0f32);
        unsafe {
            if ep.GetMute(&mut m).is_ok() && m != 0 { s.touched = true; }
            if ep.GetMasterVolumeLevelScalar(&mut v).is_ok() && (v - s.set).abs() >= 0.01 { s.touched = true; }
        }
    }
}

impl Restore {
    /// Puts back the mute and the volume from before the boost (when this is the last holder). A volume the
    /// user changed meanwhile stays.
    pub fn apply(self) {
        let mut g = SAVED.lock().unwrap();
        let Some(s) = &mut *g else { return };
        s.holders = s.holders.saturating_sub(1);
        if s.holders > 0 { return }
        let s = g.take().unwrap();
        let Some(ep) = endpoint() else { return };
        unsafe {
            let mut v = 0f32;
            if ep.GetMasterVolumeLevelScalar(&mut v).is_ok() && (v - s.set).abs() < 0.01 && s.vol < s.set {
                let _ = ep.SetMasterVolumeLevelScalar(s.vol, core::ptr::null());
            }
            // The mute goes back only when the state is still what boost() set (unmuted) and the user did not touch
            // the sound meanwhile (the same rule as the volume: a user change wins).
            let mut m = 0i32;
            if s.muted && !s.touched && ep.GetMute(&mut m).is_ok() && m == 0 { let _ = ep.SetMute(1, core::ptr::null()); }
        }
    }

    /// Restores after `secs` seconds, on its own thread.
    pub fn after(self, secs: u64) {
        std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_secs(secs)); self.apply(); });
    }
}
