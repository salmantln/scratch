//! QuietNote connections to Linear and GitHub. Keys live in the macOS Keychain and never
//! return to the webview; the network is used only to verify a key or for an explicit send.
use crate::meetings::atomic_write;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const LINEAR: &str = "https://api.linear.app/graphql";
const GITHUB: &str = "https://api.github.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Account { account: String }
#[derive(Debug, Serialize, PartialEq)]
pub struct Target { id: String, name: String }
#[derive(Deserialize)]
pub struct Item { title: String, body: String }
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Sent { label: Option<String>, url: Option<String>, error: Option<String> }

fn name(service: &str) -> Result<&'static str, String> {
    match service { "linear" => Ok("Linear"), "github" => Ok("GitHub"), _ => Err(format!("Unknown service “{service}”")) }
}
fn accounts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connections.json"))
}
fn read_accounts(app: &AppHandle) -> Result<BTreeMap<String, Account>, String> {
    let path = accounts_path(app)?;
    if !path.exists() { return Ok(BTreeMap::new()); }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("Connections file is unreadable. {e}"))
}
fn write_accounts(app: &AppHandle, accounts: &BTreeMap<String, Account>) -> Result<(), String> {
    atomic_write(&accounts_path(app)?, &serde_json::to_vec_pretty(accounts).map_err(|e| e.to_string())?)
}

#[cfg(target_os = "macos")]
mod keychain {
    fn entry(service: &str) -> Result<keyring::Entry, String> { keyring::Entry::new("app.quietnote.desktop.connectors", service).map_err(|e| e.to_string()) }
    pub fn store(service: &str, token: &str) -> Result<(), String> { entry(service)?.set_password(token).map_err(|e| format!("Couldn’t save the key to the Keychain. {e}")) }
    pub fn read(service: &str) -> Result<Option<String>, String> {
        match entry(service)?.get_password() { Ok(token) => Ok(Some(token)), Err(keyring::Error::NoEntry) => Ok(None), Err(e) => Err(format!("Couldn’t read the key from the Keychain. {e}")) }
    }
    pub fn delete(service: &str) -> Result<(), String> {
        match entry(service)?.delete_credential() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(e) => Err(format!("Couldn’t remove the key from the Keychain. {e}")) }
    }
}
#[cfg(not(target_os = "macos"))]
mod keychain {
    const UNSUPPORTED: &str = "Connections need the macOS Keychain and aren’t available on this platform yet.";
    pub fn store(_: &str, _: &str) -> Result<(), String> { Err(UNSUPPORTED.into()) }
    pub fn read(_: &str) -> Result<Option<String>, String> { Err(UNSUPPORTED.into()) }
    pub fn delete(_: &str) -> Result<(), String> { Ok(()) }
}
fn token(service: &str) -> Result<String, String> {
    keychain::read(service)?.ok_or_else(|| format!("{} isn’t connected. Connect it again in Connections.", name(service).unwrap_or(service)))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("QuietNote").timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
}
/// Turns a service response into its JSON body, or a readable error.
fn checked(service: &str, status: u16, body: Value) -> Result<Value, String> {
    let label = name(service)?;
    if status == 401 { return Err(format!("{label} rejected this key. Check it, or create a new one.")); }
    if let Some(message) = body["errors"][0]["message"].as_str() { return Err(format!("{label}: {message}")); }
    if status >= 400 { return Err(format!("{label}: {}", body["message"].as_str().unwrap_or("the request failed"))); }
    Ok(body)
}
async fn call(service: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| format!("Couldn’t reach {}. {e}", name(service).unwrap_or(service)))?;
    let status = response.status().as_u16();
    checked(service, status, response.json().await.unwrap_or(Value::Null))
}
async fn linear(token: &str, query: &str, variables: Value) -> Result<Value, String> {
    call("linear", client()?.post(LINEAR).header("Authorization", token).json(&json!({ "query": query, "variables": variables }))).await
}
fn github(token: &str, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request.bearer_auth(token).header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28")
}
fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')));
    ok(parts.next()) && ok(parts.next()) && parts.next().is_none()
}

fn linear_teams(body: &Value) -> Vec<Target> {
    body["data"]["teams"]["nodes"].as_array().into_iter().flatten()
        .filter_map(|t| Some(Target { id: t["id"].as_str()?.into(), name: format!("{} · {}", t["key"].as_str()?, t["name"].as_str()?) })).collect()
}
fn github_repos(body: &Value) -> Vec<Target> {
    body.as_array().into_iter().flatten()
        .filter(|r| r["has_issues"].as_bool() == Some(true) && r["archived"].as_bool() != Some(true))
        .filter_map(|r| r["full_name"].as_str().map(|n| Target { id: n.into(), name: n.into() })).collect()
}
fn linear_issue(body: &Value) -> Result<(String, String), String> {
    let issue = &body["data"]["issueCreate"]["issue"];
    match (issue["identifier"].as_str(), issue["url"].as_str()) { (Some(id), Some(url)) => Ok((id.into(), url.into())), _ => Err("Linear didn’t return the new issue.".into()) }
}
fn github_issue(body: &Value) -> Result<(String, String), String> {
    match (body["number"].as_u64(), body["html_url"].as_str()) { (Some(n), Some(url)) => Ok((format!("#{n}"), url.into())), _ => Err("GitHub didn’t return the new issue.".into()) }
}

async fn verify(service: &str, token: &str) -> Result<String, String> {
    let account = match service {
        "linear" => linear(token, "query { viewer { name } }", json!({})).await?["data"]["viewer"]["name"].as_str().map(String::from),
        _ => call(service, github(token, client()?.get(format!("{GITHUB}/user")))).await?["login"].as_str().map(String::from),
    };
    account.ok_or_else(|| format!("{} didn’t return an account for this key.", name(service).unwrap_or(service)))
}
async fn create(service: &str, token: &str, target: &str, item: &Item) -> Result<(String, String), String> {
    if service == "linear" {
        let mutation = "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }";
        return linear_issue(&linear(token, mutation, json!({ "input": { "teamId": target, "title": item.title, "description": item.body } })).await?);
    }
    if !valid_repo(target) { return Err("Invalid repository".into()); }
    github_issue(&call(service, github(token, client()?.post(format!("{GITHUB}/repos/{target}/issues"))).json(&json!({ "title": item.title, "body": item.body }))).await?)
}

#[tauri::command]
pub async fn connector_status(app: AppHandle) -> Result<BTreeMap<String, Account>, String> { read_accounts(&app) }
#[tauri::command]
pub async fn connector_connect(app: AppHandle, service: String, token: String) -> Result<Account, String> {
    name(&service)?;
    let token = token.trim();
    if token.is_empty() { return Err("Paste a key first.".into()); }
    let account = Account { account: verify(&service, token).await? };
    keychain::store(&service, token)?;
    let mut accounts = read_accounts(&app)?;
    accounts.insert(service, account.clone());
    write_accounts(&app, &accounts)?;
    Ok(account)
}
#[tauri::command]
pub async fn connector_disconnect(app: AppHandle, service: String) -> Result<(), String> {
    name(&service)?;
    keychain::delete(&service)?;
    let mut accounts = read_accounts(&app)?;
    accounts.remove(&service);
    write_accounts(&app, &accounts)
}
#[tauri::command]
pub async fn connector_targets(service: String) -> Result<Vec<Target>, String> {
    let token = token(&service)?;
    if service == "linear" { return Ok(linear_teams(&linear(&token, "query { teams(first: 100) { nodes { id key name } } }", json!({})).await?)); }
    Ok(github_repos(&call(&service, github(&token, client()?.get(format!("{GITHUB}/user/repos?per_page=100&sort=pushed")))).await?))
}
#[tauri::command]
pub async fn connector_send(service: String, target: String, items: Vec<Item>) -> Result<Vec<Sent>, String> {
    let token = token(&service)?;
    let mut sent = Vec::with_capacity(items.len());
    for item in &items {
        sent.push(match create(&service, &token, &target, item).await {
            Ok((label, url)) => Sent { label: Some(label), url: Some(url), error: None },
            Err(error) => Sent { error: Some(error), ..Sent::default() },
        });
    }
    Ok(sent)
}

/// Icons of installed Apple apps (and Things), read from this Mac the way Finder shows them.
/// Apple doesn't publish these icons for reuse, so nothing is bundled; apps that aren't installed are omitted.
#[cfg(target_os = "macos")]
fn app_icon(bundle: &str) -> Option<String> {
    use base64::Engine;
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};
    let workspace = NSWorkspace::sharedWorkspace();
    let path = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle))?.path()?;
    let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(128.0, 128.0));
    let image = unsafe { workspace.iconForFile(&path).CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    let png = unsafe { NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image).representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.to_vec())))
}
#[tauri::command]
pub async fn connector_app_icons() -> BTreeMap<String, String> {
    #[cfg(target_os = "macos")]
    { [("ical", "com.apple.iCal"), ("reminders", "com.apple.reminders"), ("things", "com.culturedcode.ThingsMac")].into_iter().filter_map(|(id, bundle)| Some((id.to_string(), app_icon(bundle)?))).collect() }
    #[cfg(not(target_os = "macos"))]
    { BTreeMap::new() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readable_errors() {
        assert!(checked("linear", 401, Value::Null).unwrap_err().contains("rejected this key"));
        assert_eq!(checked("linear", 200, json!({ "errors": [{ "message": "Team not found" }] })).unwrap_err(), "Linear: Team not found");
        assert_eq!(checked("github", 403, json!({ "message": "Resource not accessible by personal access token" })).unwrap_err(), "GitHub: Resource not accessible by personal access token");
        assert!(checked("jira", 200, Value::Null).is_err());
        assert_eq!(checked("github", 201, json!({ "number": 3 })).unwrap(), json!({ "number": 3 }));
    }
    #[test]
    fn parses_targets() {
        assert_eq!(linear_teams(&json!({ "data": { "teams": { "nodes": [{ "id": "t1", "key": "ENG", "name": "Engineering" }] } } })), vec![Target { id: "t1".into(), name: "ENG · Engineering".into() }]);
        let repos = json!([{ "full_name": "acme/app", "has_issues": true }, { "full_name": "acme/old", "has_issues": true, "archived": true }, { "full_name": "acme/wiki", "has_issues": false }]);
        assert_eq!(github_repos(&repos), vec![Target { id: "acme/app".into(), name: "acme/app".into() }]);
    }
    #[test]
    fn parses_created_issues() {
        assert_eq!(linear_issue(&json!({ "data": { "issueCreate": { "success": true, "issue": { "identifier": "ENG-12", "url": "https://linear.app/acme/issue/ENG-12" } } } })).unwrap(), ("ENG-12".into(), "https://linear.app/acme/issue/ENG-12".into()));
        assert_eq!(github_issue(&json!({ "number": 7, "html_url": "https://github.com/acme/app/issues/7" })).unwrap(), ("#7".into(), "https://github.com/acme/app/issues/7".into()));
        assert!(linear_issue(&json!({ "data": { "issueCreate": { "success": false, "issue": null } } })).is_err());
    }
    #[test]
    fn validates_repositories() {
        assert!(valid_repo("acme/app.js"));
        for invalid in ["acme", "acme/", "../x", "acme/app/issues", "acme/..", "acme/a b"] { assert!(!valid_repo(invalid), "{invalid}"); }
    }
}
