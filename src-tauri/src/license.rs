//! The QuietNote subscription, sold through Lemon Squeezy (monthly or yearly: two variants of one product).
//! Recording needs an active one; meetings, notes, transcripts and exports never do. The key is activated when the
//! user enters it (the key and the fixed name "QuietNote for Mac"), then checked at launch and once a day (the key
//! and this Mac's activation ID, nothing else), and kept in the Keychain. What the app shows, and when a check last
//! succeeded, is in `<app data>/license.json`. Recording keeps working for `GRACE` after the last successful check,
//! so a Mac that's offline still records; Lemon Squeezy saying the key expired or was disabled stops it at once.
//! Store and product ids are set at build time; without them there's nothing to check and recording is never held.
use crate::connectors::keychain;
use crate::meetings::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const API: &str = "https://api.lemonsqueezy.com/v1/licenses";
const ACCOUNT: &str = "license";
const INSTANCE: &str = "QuietNote for Mac";
const DAY: i64 = 86_400_000;
/// How long recording keeps working without a successful check (offline, or Lemon Squeezy down).
const GRACE: i64 = 14 * DAY;
/// A subscription not checked for this long shows as "couldn't check", with the date recording stops.
const LATE: i64 = 2 * DAY;

#[derive(Clone, Copy)]
struct Store { id: u64, product: u64 }
fn store() -> Option<Store> {
    if !cfg!(target_os = "macos") { return None; }
    let id = |v: Option<&str>| v?.trim().parse().ok();
    Some(Store { id: id(option_env!("QUIETNOTE_LS_STORE_ID"))?, product: id(option_env!("QUIETNOTE_LS_PRODUCT"))? })
}

/// Why a subscription stopped: Lemon Squeezy expired the key (the paid period ended) or disabled it (a refund),
/// or no longer knows the key or this Mac's activation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ended { Expired, Disabled, Invalid }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    name: String,
    /// The variant bought, e.g. "Monthly" or "Yearly".
    plan: String,
    activated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    renews_at: Option<String>,
    instance_id: String,
    /// When Lemon Squeezy last confirmed the key (ms since the epoch).
    checked_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ended: Option<Ended>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State { None, Active, Offline, Ended, Invalid }
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    available: bool,
    state: State,
    may_record: bool,
    /// While offline: when recording stops (or stopped) without a successful check.
    #[serde(skip_serializing_if = "Option::is_none")]
    locks_at: Option<i64>,
    license: Option<License>,
}
impl Status {
    fn new(available: bool, license: Option<License>, now: i64) -> Status {
        let (state, locks_at) = match &license {
            _ if !available => (State::None, None),
            None => (State::None, None),
            Some(License { ended: Some(Ended::Invalid), .. }) => (State::Invalid, None),
            Some(License { ended: Some(_), .. }) => (State::Ended, None),
            Some(l) if now - l.checked_at < LATE => (State::Active, None),
            Some(l) => (State::Offline, Some(l.checked_at + GRACE)),
        };
        let may_record = !available || state == State::Active || locks_at.is_some_and(|at| now < at);
        Status { available, state, may_record, locks_at, license }
    }
}

/// What Lemon Squeezy said about a key, from an activation or a check.
#[derive(Debug, PartialEq)]
enum Answer { Active { name: String, plan: String, renews_at: Option<String> }, Ended(Ended) }
/// Reads Lemon Squeezy's reply. `Err` means it couldn't tell (unreachable, or an unexpected reply).
fn answer(store: Store, status: u16, body: &Value) -> Result<Answer, String> {
    let error = body["error"].as_str().filter(|e| !e.is_empty());
    if status == 404 || error.is_some_and(|e| e.contains("not found")) { return Ok(Answer::Ended(Ended::Invalid)); }
    let key = &body["license_key"];
    match key["status"].as_str() {
        Some("expired") => return Ok(Answer::Ended(Ended::Expired)),
        Some("disabled") => return Ok(Answer::Ended(Ended::Disabled)),
        _ => {}
    }
    if let Some(error) = error { return Err(format!("Lemon Squeezy: {error}")); }
    if status >= 400 || !(body["activated"].as_bool() == Some(true) || body["valid"].as_bool() == Some(true)) {
        return Err("Lemon Squeezy didn’t confirm this key. Try again.".into());
    }
    let meta = &body["meta"];
    if meta["store_id"].as_u64() != Some(store.id) || meta["product_id"].as_u64() != Some(store.product) { return Ok(Answer::Ended(Ended::Invalid)); }
    Ok(Answer::Active { name: text(&meta["customer_name"]).unwrap_or_default(), plan: text(&meta["variant_name"]).unwrap_or_default(), renews_at: text(&key["expires_at"]) })
}
fn text(v: &Value) -> Option<String> { v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from) }
/// The license after a check: confirmed now, or ended. A key that ended can come back (a renewed subscription).
fn apply(license: License, answer: Answer, now: i64) -> License {
    match answer {
        Answer::Active { name, plan, renews_at } => License { name, plan, renews_at, checked_at: now, ended: None, ..license },
        Answer::Ended(why) => License { ended: Some(why), ..license },
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("license.json"))
}
fn read(app: &AppHandle) -> Result<Option<License>, String> {
    let path = path(app)?;
    if !path.exists() { return Ok(None); }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map(Some).map_err(|e| format!("The license file is unreadable. {e}"))
}
fn write(app: &AppHandle, license: &License) -> Result<(), String> {
    atomic_write(&path(app)?, &serde_json::to_vec_pretty(license).map_err(|e| e.to_string())?)
}
fn now() -> i64 { chrono::Utc::now().timestamp_millis() }
fn status(app: &AppHandle) -> Result<Status, String> { Ok(Status::new(store().is_some(), read(app)?, now())) }
/// Tells the windows the subscription changed (the Shell holds recording, Settings shows it).
fn changed(app: &AppHandle) -> Result<Status, String> {
    let status = status(app)?;
    let _ = app.emit("quietnote://license-changed", &status);
    Ok(status)
}
async fn post(action: &str, pairs: &[(&str, &str)]) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder().user_agent("QuietNote").timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let body = pairs.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect::<Vec<_>>().join("&");
    let response = client.post(format!("{API}/{action}")).header("Accept", "application/json").header("Content-Type", "application/x-www-form-urlencoded").body(body)
        .send().await.map_err(|e| format!("Couldn’t reach Lemon Squeezy. {e}"))?;
    let status = response.status().as_u16();
    Ok((status, response.json().await.unwrap_or(Value::Null)))
}
/// Asks Lemon Squeezy about the stored key and this Mac's activation, and keeps the answer.
/// `Err` when it couldn't be asked; the last successful check then still counts.
async fn check(app: &AppHandle) -> Result<Status, String> {
    let store = store().ok_or("Subscriptions aren’t available in this build.")?;
    let (Some(license), Some(key)) = (read(app)?, keychain::read(ACCOUNT)?) else { return status(app) };
    let (code, body) = post("validate", &[("license_key", &key), ("instance_id", &license.instance_id)]).await?;
    write(app, &apply(license, answer(store, code, &body)?, now()))?;
    changed(app)
}

/// Whether a new recording may start: an active subscription, or one in its offline grace.
pub fn may_record(app: &AppHandle) -> Result<bool, String> { status(app).map(|s| s.may_record) }

/// Checks at launch, then once a day while QuietNote runs. Woken every 15 minutes, so a Mac that slept still
/// checks soon after it wakes. A key that's no longer known isn't asked about again until it's entered again.
pub fn spawn(app: &AppHandle) {
    if store().is_none() { return; }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = i64::MIN;
        loop {
            let due = now().saturating_sub(last) >= DAY && read(&app).ok().flatten().is_some_and(|l| l.ended != Some(Ended::Invalid));
            if due {
                last = now();
                let _ = tauri::async_runtime::block_on(check(&app));
            }
            std::thread::sleep(Duration::from_secs(15 * 60));
        }
    });
}

#[tauri::command]
pub fn license_status(app: AppHandle) -> Result<Status, String> { status(&app) }
#[tauri::command]
pub async fn license_activate(app: AppHandle, key: String) -> Result<Status, String> {
    let store = store().ok_or("Subscriptions aren’t available in this build.")?;
    let key = key.trim();
    if key.is_empty() { return Err("Paste a license key first.".into()); }
    let (code, body) = post("activate", &[("license_key", key), ("instance_name", INSTANCE)]).await?;
    let (name, plan, renews_at) = match answer(store, code, &body)? {
        Answer::Active { name, plan, renews_at } => (name, plan, renews_at),
        Answer::Ended(Ended::Expired) => return Err("This subscription has ended. Renew it, then enter the key again.".into()),
        Answer::Ended(Ended::Disabled) => return Err("This license key has been disabled.".into()),
        Answer::Ended(Ended::Invalid) => return Err("This license key wasn’t found, or isn’t for QuietNote. Check it and try again.".into()),
    };
    let instance_id = text(&body["instance"]["id"]).ok_or("Lemon Squeezy didn’t return an activation.")?;
    let activated_at = text(&body["instance"]["created_at"]).unwrap_or_default();
    keychain::store(ACCOUNT, key)?;
    write(&app, &License { name, plan, activated_at, renews_at, instance_id, checked_at: now(), ended: None })?;
    changed(&app)
}
/// Check now, from Settings: the same check as the daily one.
#[tauri::command]
pub async fn license_check(app: AppHandle) -> Result<Status, String> { check(&app).await }
/// Frees this Mac's activation, then forgets the license. Returns a note when Lemon Squeezy couldn't be told,
/// since the license is removed from this Mac either way.
#[tauri::command]
pub async fn license_remove(app: AppHandle) -> Result<Option<String>, String> {
    let instance = read(&app)?.map(|l| l.instance_id);
    let note = match (keychain::read(ACCOUNT)?, instance) {
        (Some(key), Some(instance)) => match post("deactivate", &[("license_key", &key), ("instance_id", &instance)]).await {
            Ok((status, body)) if status < 400 && body["deactivated"].as_bool() == Some(true) => None,
            _ => Some("Removed from this Mac. Lemon Squeezy couldn’t be reached, so this activation still counts toward the key’s limit.".to_string()),
        },
        _ => None,
    };
    keychain::delete(ACCOUNT)?;
    let path = path(&app)?;
    if path.exists() { std::fs::remove_file(path).map_err(|e| format!("Couldn’t remove the license file. {e}"))?; }
    changed(&app)?;
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const STORE: Store = Store { id: 1, product: 10 };
    const NOW: i64 = 1_800_000_000_000;
    fn license(checked_at: i64, ended: Option<Ended>) -> License {
        License { name: "Ada".into(), plan: "Monthly".into(), activated_at: "2026-10-25T10:00:00.000000Z".into(), renews_at: None, instance_id: "i-1".into(), checked_at, ended }
    }
    fn reply(field: &str, product: u64, key: Value) -> Value {
        json!({
            field: true, "error": null, "license_key": key,
            "instance": { "id": "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17", "name": INSTANCE, "created_at": "2026-10-25T10:00:00.000000Z" },
            "meta": { "store_id": 1, "product_id": product, "variant_name": "Yearly", "customer_name": " Ada Lovelace ", "customer_email": "ada@example.com" }
        })
    }
    fn state(license: Option<License>, now: i64) -> (State, bool, Option<i64>) {
        let s = Status::new(true, license, now);
        (s.state, s.may_record, s.locks_at)
    }

    #[test]
    fn without_a_license_recording_waits() {
        assert_eq!(state(None, NOW), (State::None, false, None));
    }
    #[test]
    fn builds_without_a_store_never_hold_recording() {
        let s = Status::new(false, Some(license(0, Some(Ended::Expired))), NOW);
        assert_eq!((s.state, s.may_record), (State::None, true));
    }
    #[test]
    fn a_recent_check_is_active() {
        assert_eq!(state(Some(license(NOW, None)), NOW), (State::Active, true, None));
        assert_eq!(state(Some(license(NOW - LATE + 1, None)), NOW), (State::Active, true, None));
        // A clock set back doesn't lock anyone out.
        assert_eq!(state(Some(license(NOW + DAY, None)), NOW), (State::Active, true, None));
    }
    #[test]
    fn offline_keeps_recording_until_the_grace_runs_out() {
        let checked = NOW - 5 * DAY;
        assert_eq!(state(Some(license(checked, None)), NOW), (State::Offline, true, Some(checked + GRACE)));
        assert_eq!(state(Some(license(checked, None)), checked + GRACE - 1), (State::Offline, true, Some(checked + GRACE)));
        assert_eq!(state(Some(license(checked, None)), checked + GRACE), (State::Offline, false, Some(checked + GRACE)));
    }
    #[test]
    fn an_ended_or_unknown_key_stops_recording_at_once() {
        assert_eq!(state(Some(license(NOW, Some(Ended::Expired))), NOW), (State::Ended, false, None));
        assert_eq!(state(Some(license(NOW, Some(Ended::Disabled))), NOW), (State::Ended, false, None));
        assert_eq!(state(Some(license(NOW, Some(Ended::Invalid))), NOW), (State::Invalid, false, None));
    }
    #[test]
    fn a_check_confirms_ends_or_brings_a_subscription_back() {
        let old = license(NOW - 20 * DAY, None);
        let renewed = apply(old.clone(), Answer::Active { name: "Ada".into(), plan: "Yearly".into(), renews_at: Some("2027-10-25".into()) }, NOW);
        assert_eq!((renewed.checked_at, renewed.plan.as_str(), renewed.renews_at.as_deref(), renewed.ended), (NOW, "Yearly", Some("2027-10-25"), None));
        let ended = apply(old.clone(), Answer::Ended(Ended::Expired), NOW);
        assert_eq!((ended.checked_at, ended.ended), (old.checked_at, Some(Ended::Expired)));
        let back = apply(ended, Answer::Active { name: "Ada".into(), plan: "Monthly".into(), renews_at: None }, NOW);
        assert_eq!(state(Some(back), NOW), (State::Active, true, None));
    }
    #[test]
    fn reads_activations_and_checks() {
        let active = Answer::Active { name: "Ada Lovelace".into(), plan: "Yearly".into(), renews_at: Some("2027-10-25T10:00:00.000000Z".into()) };
        let key = json!({ "status": "active", "activation_limit": 3, "expires_at": "2027-10-25T10:00:00.000000Z" });
        assert_eq!(answer(STORE, 200, &reply("activated", 10, key.clone())).unwrap(), active);
        assert_eq!(answer(STORE, 200, &reply("valid", 10, key)).unwrap(), active);
    }
    #[test]
    fn reads_keys_that_ended_or_were_never_ours() {
        assert_eq!(answer(STORE, 200, &reply("valid", 10, json!({ "status": "expired" }))).unwrap(), Answer::Ended(Ended::Expired));
        // Lemon Squeezy reports an expired key as not valid, with an error.
        let mut expired = reply("valid", 10, json!({ "status": "expired" }));
        expired["valid"] = json!(false); expired["error"] = json!("This license key has expired.");
        assert_eq!(answer(STORE, 400, &expired).unwrap(), Answer::Ended(Ended::Expired));
        assert_eq!(answer(STORE, 200, &reply("valid", 10, json!({ "status": "disabled" }))).unwrap(), Answer::Ended(Ended::Disabled));
        assert_eq!(answer(STORE, 404, &json!({ "error": "license_key not found." })).unwrap(), Answer::Ended(Ended::Invalid));
        assert_eq!(answer(STORE, 404, &json!({ "valid": false, "error": "license_key instance not found." })).unwrap(), Answer::Ended(Ended::Invalid));
        assert_eq!(answer(STORE, 200, &reply("valid", 99, json!({ "status": "active" }))).unwrap(), Answer::Ended(Ended::Invalid));
        let mut other = reply("valid", 10, json!({ "status": "active" }));
        other["meta"]["store_id"] = json!(2);
        assert_eq!(answer(STORE, 200, &other).unwrap(), Answer::Ended(Ended::Invalid));
    }
    #[test]
    fn replies_that_dont_say_leave_the_last_check_standing() {
        let limit = json!({ "activated": false, "error": "This license key has reached the activation limit.", "meta": { "store_id": 1, "product_id": 10 } });
        assert_eq!(answer(STORE, 400, &limit).unwrap_err(), "Lemon Squeezy: This license key has reached the activation limit.");
        assert!(answer(STORE, 500, &Value::Null).is_err());
        assert!(answer(STORE, 200, &json!({ "valid": false })).is_err());
    }
}
