//! Optional supporter and commercial licenses, sold through Lemon Squeezy. A license unlocks no features.
//! The key is checked once, when the user enters it (Lemon Squeezy's license API, with a fixed device name),
//! then kept in the Keychain; what the About screen shows is in `<app data>/license.json` and is read without
//! the network. Store and product ids are set at build time; without them licenses are unavailable.
use crate::connectors::keychain;
use crate::meetings::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const API: &str = "https://api.lemonsqueezy.com/v1/licenses";
const ACCOUNT: &str = "license";
const INSTANCE: &str = "QuietNote for Mac";

#[derive(Clone, Copy)]
struct Store { id: u64, supporter: u64, commercial: u64 }
fn store() -> Option<Store> {
    if !cfg!(target_os = "macos") { return None; }
    let id = |v: Option<&str>| v?.trim().parse().ok();
    Some(Store { id: id(option_env!("QUIETNOTE_LS_STORE_ID"))?, supporter: id(option_env!("QUIETNOTE_LS_SUPPORTER"))?, commercial: id(option_env!("QUIETNOTE_LS_COMMERCIAL"))? })
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind { Supporter, Commercial }
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    kind: Kind,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    seats: Option<u64>,
    activated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    instance_id: String,
}
#[derive(Debug, Serialize)]
pub struct Status { available: bool, license: Option<License> }

fn kind_of(store: Store, product: u64) -> Option<Kind> {
    if product == store.supporter { Some(Kind::Supporter) } else if product == store.commercial { Some(Kind::Commercial) } else { None }
}
/// Reads an activation response into the license to keep, or the reason it can't be used.
fn parse(store: Store, status: u16, body: &Value) -> Result<License, String> {
    if status == 404 || body["error"].as_str().is_some_and(|e| e.contains("not found")) { return Err("This license key wasn’t found. Check it and try again.".into()); }
    if let Some(error) = body["error"].as_str().filter(|e| !e.is_empty()) { return Err(format!("Lemon Squeezy: {error}")); }
    if status >= 400 || body["activated"].as_bool() != Some(true) { return Err("Lemon Squeezy didn’t activate this key. Try again.".into()); }
    let meta = &body["meta"];
    let kind = (meta["store_id"].as_u64() == Some(store.id)).then(|| meta["product_id"].as_u64().and_then(|p| kind_of(store, p))).flatten()
        .ok_or("This key isn’t for QuietNote.")?;
    let key = &body["license_key"];
    match key["status"].as_str() {
        Some("expired") => return Err("This license has expired.".into()),
        Some("disabled") => return Err("This license has been disabled.".into()),
        _ => {}
    }
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    Ok(License {
        kind,
        name: text(&meta["customer_name"]).unwrap_or_default(),
        seats: if kind == Kind::Commercial { key["activation_limit"].as_u64() } else { None },
        activated_at: text(&body["instance"]["created_at"]).unwrap_or_default(),
        expires_at: if kind == Kind::Commercial { text(&key["expires_at"]) } else { None },
        instance_id: text(&body["instance"]["id"]).ok_or("Lemon Squeezy didn’t return an activation.")?,
    })
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
async fn post(action: &str, pairs: &[(&str, &str)]) -> Result<(u16, Value), String> {
    let client = reqwest::Client::builder().user_agent("QuietNote").timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let body = pairs.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect::<Vec<_>>().join("&");
    let response = client.post(format!("{API}/{action}")).header("Accept", "application/json").header("Content-Type", "application/x-www-form-urlencoded").body(body)
        .send().await.map_err(|e| format!("Couldn’t reach Lemon Squeezy. {e}"))?;
    let status = response.status().as_u16();
    Ok((status, response.json().await.unwrap_or(Value::Null)))
}

#[tauri::command]
pub fn license_status(app: AppHandle) -> Result<Status, String> {
    Ok(Status { available: store().is_some(), license: read(&app)? })
}
#[tauri::command]
pub async fn license_activate(app: AppHandle, key: String) -> Result<License, String> {
    let store = store().ok_or("Licenses aren’t available in this build.")?;
    let key = key.trim();
    if key.is_empty() { return Err("Paste a license key first.".into()); }
    let (status, body) = post("activate", &[("license_key", key), ("instance_name", INSTANCE)]).await?;
    let license = parse(store, status, &body)?;
    keychain::store(ACCOUNT, key)?;
    atomic_write(&path(&app)?, &serde_json::to_vec_pretty(&license).map_err(|e| e.to_string())?)?;
    Ok(license)
}
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
    Ok(note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const STORE: Store = Store { id: 1, supporter: 10, commercial: 20 };
    fn activated(product: u64, key: Value) -> Value {
        json!({
            "activated": true, "error": null, "license_key": key,
            "instance": { "id": "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17", "name": INSTANCE, "created_at": "2026-10-25T10:00:00.000000Z" },
            "meta": { "store_id": 1, "product_id": product, "customer_name": " Acme BV ", "customer_email": "ops@acme.example" }
        })
    }
    #[test]
    fn reads_a_supporter_license() {
        let license = parse(STORE, 200, &activated(10, json!({ "status": "active", "activation_limit": 5, "expires_at": null }))).unwrap();
        assert_eq!(license, License { kind: Kind::Supporter, name: "Acme BV".into(), seats: None, activated_at: "2026-10-25T10:00:00.000000Z".into(), expires_at: None, instance_id: "47596ad9-a811-4ebf-ac8a-03fc7b6d2a17".into() });
    }
    #[test]
    fn reads_a_commercial_license_with_seats_and_renewal() {
        let license = parse(STORE, 200, &activated(20, json!({ "status": "active", "activation_limit": 12, "expires_at": "2027-10-25T10:00:00.000000Z" }))).unwrap();
        assert_eq!((license.kind, license.seats, license.expires_at.as_deref()), (Kind::Commercial, Some(12), Some("2027-10-25T10:00:00.000000Z")));
    }
    #[test]
    fn refuses_keys_that_cant_be_used() {
        let limit = json!({ "activated": false, "error": "This license key has reached the activation limit.", "meta": { "store_id": 1, "product_id": 10 } });
        assert_eq!(parse(STORE, 400, &limit).unwrap_err(), "Lemon Squeezy: This license key has reached the activation limit.");
        assert!(parse(STORE, 404, &json!({ "error": "license_key not found." })).unwrap_err().contains("wasn’t found"));
        assert_eq!(parse(STORE, 200, &activated(99, json!({ "status": "active" }))).unwrap_err(), "This key isn’t for QuietNote.");
        let mut other = activated(10, json!({ "status": "active" }));
        other["meta"]["store_id"] = json!(2);
        assert_eq!(parse(STORE, 200, &other).unwrap_err(), "This key isn’t for QuietNote.");
        assert_eq!(parse(STORE, 200, &activated(20, json!({ "status": "expired" }))).unwrap_err(), "This license has expired.");
        assert_eq!(parse(STORE, 200, &activated(10, json!({ "status": "disabled" }))).unwrap_err(), "This license has been disabled.");
        assert!(parse(STORE, 500, &Value::Null).is_err());
    }
    #[test]
    fn kinds_by_product() {
        assert_eq!(kind_of(STORE, 10), Some(Kind::Supporter));
        assert_eq!(kind_of(STORE, 20), Some(Kind::Commercial));
        assert_eq!(kind_of(STORE, 30), None);
    }
}
