//! Signing in to a connected service through the browser, with no QuietNote server in between: OAuth for
//! native apps (RFC 8252: the system browser, PKCE, a loopback redirect), or a provider's device flow
//! (RFC 8628) where its browser flow needs a client secret. Only public client IDs are built in, set at
//! build time; without one, a service is connected with a pasted key instead. Tokens go to the Keychain.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub enum Flow {
    /// The browser opens the provider's page and it redirects back to a local port.
    Browser { authorize: &'static str, token: &'static str },
    /// The user types a short code on the provider's page while QuietNote waits.
    Device { code: &'static str, token: &'static str },
}
/// One row per service: everything that differs between providers lives here, not in the flows.
pub struct Provider { pub service: &'static str, pub name: &'static str, client_id: Option<&'static str>, scopes: &'static str, flow: Flow }
const PROVIDERS: &[Provider] = &[
    // Linear accepts PKCE without a secret; access tokens last a day and come with a refresh token.
    Provider { service: "linear", name: "Linear", client_id: option_env!("QUIETNOTE_LINEAR_CLIENT_ID"), scopes: "read,issues:create",
        flow: Flow::Browser { authorize: "https://linear.app/oauth/authorize", token: "https://api.linear.app/oauth/token" } },
    // GitHub's browser flow requires a client secret, its device flow doesn't. `repo` lists private repositories.
    Provider { service: "github", name: "GitHub", client_id: option_env!("QUIETNOTE_GITHUB_CLIENT_ID"), scopes: "repo",
        flow: Flow::Device { code: "https://github.com/login/device/code", token: "https://github.com/login/oauth/access_token" } },
];
/// Loopback ports tried in order, each registered as `http://127.0.0.1:<port>/callback` with the provider.
pub const PORTS: [u16; 3] = [47821, 47822, 47823];
const WAIT: Duration = Duration::from_secs(10 * 60);

pub fn provider(service: &str) -> Option<&'static Provider> { PROVIDERS.iter().find(|p| p.service == service && p.client_id.is_some()) }

/// What's kept in the Keychain after signing in. A pasted key is kept as itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tokens { pub access: String, pub refresh: Option<String>, pub expires_at: Option<i64> }
impl Tokens {
    pub fn parse(stored: &str) -> Option<Tokens> { stored.starts_with('{').then(|| serde_json::from_str(stored).ok()).flatten() }
    /// Due for a refresh: expiring within two minutes, and refreshable.
    pub fn stale(&self, now: i64) -> bool { self.refresh.is_some() && self.expires_at.is_some_and(|at| at - now < 120) }
}
pub fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64) }

/// Shown in the window while signing in: the page to open, and for a device flow the code to type there.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Waiting { service: String, url: String, code: Option<String>, opened: bool }

static PENDING: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);
pub fn cancel(service: &str) { if let Some(flag) = PENDING.lock().ok().and_then(|p| p.get(service).cloned()) { flag.store(true, Ordering::SeqCst); } }
fn cancelled(name: &str) -> String { format!("{name} sign-in was cancelled.") }

fn random(bytes: usize) -> Result<String, String> {
    use base64::Engine;
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|e| format!("Couldn’t start signing in. {e}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer))
}
fn challenge(verifier: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
fn form(pairs: &[(&str, &str)]) -> String { pairs.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect::<Vec<_>>().join("&") }
fn authorize_url(authorize: &str, client_id: &str, scopes: &str, redirect: &str, state: &str, verifier: &str) -> String {
    format!("{authorize}?{}", form(&[("client_id", client_id), ("redirect_uri", redirect), ("response_type", "code"), ("scope", scopes), ("state", state), ("code_challenge", &challenge(verifier)), ("code_challenge_method", "S256")]))
}

/// A request to the loopback port: `None` for anything that isn't our callback (a favicon, a stale tab), so
/// waiting goes on; otherwise the code, or why there isn't one.
fn callback(target: &str, state: &str, name: &str) -> Option<Result<String, String>> {
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" { return None; }
    let param = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    // Another sign-in's redirect (or a forged one) doesn't end this one.
    if param("state").as_deref() != Some(state) { return None; }
    if let Some(error) = param("error") {
        return Some(Err(if error == "access_denied" { cancelled(name) } else { format!("{name} didn’t finish signing in: {}", param("error_description").unwrap_or(error)) }));
    }
    Some(param("code").filter(|c| !c.is_empty()).ok_or_else(|| format!("{name} didn’t send a sign-in code.")))
}
fn reply(mut stream: TcpStream, status: &str, message: &str) {
    let body = format!("<!doctype html><meta charset=utf-8><title>QuietNote</title><body style=\"font:15px -apple-system,sans-serif;margin:20vh auto;max-width:26em;text-align:center;color:#182033\"><p>{message}</p>");
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}
/// Waits on the loopback port for the browser to come back with a code.
fn wait_for_code(listener: TcpListener, state: &str, name: &str, stop: &AtomicBool) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + WAIT;
    loop {
        if stop.load(Ordering::SeqCst) { return Err(cancelled(name)); }
        if Instant::now() > deadline { return Err(format!("{name} sign-in didn’t finish in time. Try again.")); }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(200)); continue; }
            Err(e) => return Err(format!("Couldn’t receive the sign-in from your browser. {e}")),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = [0u8; 8192];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let target = request.lines().next().and_then(|l| l.strip_prefix("GET ")).and_then(|l| l.split(' ').next()).unwrap_or("");
        match callback(target, state, name) {
            None => reply(stream, "404 Not Found", "Nothing here. Go back to QuietNote."),
            Some(Ok(code)) => { reply(stream, "200 OK", &format!("Signed in to {name}. You can close this tab and go back to QuietNote.")); return Ok(code); }
            Some(Err(error)) => { reply(stream, "200 OK", &format!("{error} You can close this tab and go back to QuietNote.")); return Err(error); }
        }
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent("QuietNote").timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
}
async fn post(url: &str, body: String) -> Result<Value, String> {
    let response = client()?.post(url).header("Content-Type", "application/x-www-form-urlencoded").header("Accept", "application/json").body(body).send().await
        .map_err(|e| format!("Couldn’t reach the sign-in service. {e}"))?;
    response.json().await.map_err(|e| format!("The sign-in service sent an unreadable answer. {e}"))
}
/// A token response, or the provider's reason for refusing.
fn tokens(body: &Value, name: &str, now: i64) -> Result<Tokens, String> {
    if let Some(access) = body["access_token"].as_str().filter(|a| !a.is_empty()) {
        return Ok(Tokens { access: access.into(), refresh: body["refresh_token"].as_str().map(String::from), expires_at: body["expires_in"].as_i64().map(|s| now + s) });
    }
    Err(format!("{name} didn’t sign you in: {}", body["error_description"].as_str().or(body["error"].as_str()).unwrap_or("no token came back")))
}
/// A new access token from a refresh token (PKCE clients refresh with their client ID alone).
pub async fn refresh(service: &str, refresh: &str) -> Result<Tokens, String> {
    let p = provider(service).ok_or("This service can’t refresh its sign-in.")?;
    let Flow::Browser { token, .. } = p.flow else { return Err("This service can’t refresh its sign-in.".into()) };
    let body = post(token, form(&[("grant_type", "refresh_token"), ("refresh_token", refresh), ("client_id", p.client_id.unwrap_or_default())])).await?;
    tokens(&body, p.name, now()).map_err(|_| format!("{} signed you out. Connect it again in Connections.", p.name))
}

fn show(app: &AppHandle, waiting: Waiting) { let _ = app.emit("quietnote://sign-in", waiting); }
fn focus(app: &AppHandle) { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } }

/// Signs in to `service` and returns its tokens; the window follows along through `quietnote://sign-in`.
pub async fn sign_in(app: &AppHandle, service: &str) -> Result<Tokens, String> {
    let p = provider(service).ok_or_else(|| format!("Signing in to {service} isn’t set up in this build. Use a key instead."))?;
    let client_id = p.client_id.unwrap_or_default();
    let stop = Arc::new(AtomicBool::new(false));
    PENDING.lock().map_err(|e| e.to_string())?.insert(service.into(), stop.clone());
    let result = match p.flow {
        Flow::Browser { authorize, token } => browser(app, p, client_id, authorize, token, stop).await,
        Flow::Device { code, token } => device(app, p, client_id, code, token, &stop).await,
    };
    if let Ok(mut pending) = PENDING.lock() { pending.remove(service); }
    result
}
async fn browser(app: &AppHandle, p: &Provider, client_id: &str, authorize: &str, token: &str, stop: Arc<AtomicBool>) -> Result<Tokens, String> {
    let (listener, port) = PORTS.iter().find_map(|&port| TcpListener::bind(("127.0.0.1", port)).ok().map(|l| (l, port)))
        .ok_or_else(|| format!("Couldn’t start signing in to {}: ports {}–{} on this Mac are in use. Try again in a moment.", p.name, PORTS[0], PORTS[2]))?;
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let (state, verifier) = (random(24)?, random(48)?);
    let url = authorize_url(authorize, client_id, p.scopes, &redirect, &state, &verifier);
    let opened = open::that_detached(&url).is_ok();
    show(app, Waiting { service: p.service.into(), url, code: None, opened });
    let name = p.name;
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state, name, &stop)).await.map_err(|e| e.to_string())??;
    focus(app);
    let body = post(token, form(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", &redirect), ("client_id", client_id), ("code_verifier", &verifier)])).await?;
    tokens(&body, p.name, now())
}
/// What one poll of a device flow means: keep waiting (at least this long), or stop.
#[derive(Debug, PartialEq)]
enum Poll { Wait(u64), Done(Result<Tokens, String>) }
fn poll(body: &Value, interval: u64, name: &str, now: i64) -> Poll {
    match body["error"].as_str() {
        Some("authorization_pending") => Poll::Wait(interval),
        Some("slow_down") => Poll::Wait(body["interval"].as_u64().unwrap_or(interval + 5)),
        Some("access_denied") => Poll::Done(Err(cancelled(name))),
        Some("expired_token" | "token_expired") => Poll::Done(Err(format!("The {name} code expired. Try again."))),
        _ => Poll::Done(tokens(body, name, now)),
    }
}
async fn device(app: &AppHandle, p: &Provider, client_id: &str, code: &str, token: &str, stop: &AtomicBool) -> Result<Tokens, String> {
    let start = post(code, form(&[("client_id", client_id), ("scope", p.scopes)])).await?;
    let (Some(device_code), Some(user_code), Some(url)) = (start["device_code"].as_str(), start["user_code"].as_str(), start["verification_uri"].as_str())
        else { return Err(format!("{} didn’t start signing in: {}", p.name, start["error_description"].as_str().unwrap_or("no code came back"))) };
    show(app, Waiting { service: p.service.into(), url: url.into(), code: Some(user_code.into()), opened: false });
    let deadline = Instant::now() + Duration::from_secs(start["expires_in"].as_u64().unwrap_or(900));
    let mut interval = start["interval"].as_u64().unwrap_or(5);
    loop {
        // Short sleeps, so Cancel is noticed at once.
        let until = Instant::now() + Duration::from_secs(interval);
        while Instant::now() < until {
            if stop.load(Ordering::SeqCst) { return Err(cancelled(p.name)); }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if Instant::now() > deadline { return Err(format!("The {} code expired. Try again.", p.name)); }
        let body = post(token, form(&[("client_id", client_id), ("device_code", device_code), ("grant_type", "urn:ietf:params:oauth:grant-type:device_code")])).await?;
        match poll(&body, interval, p.name, now()) {
            Poll::Wait(next) => interval = next,
            Poll::Done(result) => { focus(app); return result; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn pkce_matches_the_rfc_example() {
        // RFC 7636, appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let url = authorize_url("https://linear.app/oauth/authorize", "abc", "read,issues:create", "http://127.0.0.1:47821/callback", "s1", "v");
        assert!(url.starts_with("https://linear.app/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A47821%2Fcallback&response_type=code&scope=read%2Cissues%3Acreate&state=s1&code_challenge="));
        assert!(url.ends_with("&code_challenge_method=S256"));
        assert_ne!(random(24).unwrap(), random(24).unwrap());
    }
    #[test]
    fn reads_the_callback() {
        assert_eq!(callback("/callback?code=c1&state=s1", "s1", "Linear"), Some(Ok("c1".into())));
        assert_eq!(callback("/favicon.ico", "s1", "Linear"), None);
        assert_eq!(callback("/callback?code=c1&state=other", "s1", "Linear"), None);
        assert_eq!(callback("/callback?error=access_denied&state=s1", "s1", "Linear"), Some(Err("Linear sign-in was cancelled.".into())));
        assert!(callback("/callback?error=invalid_scope&error_description=Bad%20scope&state=s1", "s1", "Linear").unwrap().unwrap_err().ends_with("Bad scope"));
        assert!(callback("/callback?state=s1", "s1", "Linear").unwrap().is_err());
    }
    #[test]
    fn reads_tokens_and_polls() {
        let t = tokens(&json!({ "access_token": "a", "refresh_token": "r", "expires_in": 86399 }), "Linear", 1000).unwrap();
        assert_eq!(t, Tokens { access: "a".into(), refresh: Some("r".into()), expires_at: Some(87399) });
        assert!(!t.stale(1000) && t.stale(87300));
        assert!(!Tokens { access: "a".into(), refresh: None, expires_at: Some(0) }.stale(1000));
        assert_eq!(Tokens::parse(&serde_json::to_string(&t).unwrap()), Some(t));
        assert_eq!(Tokens::parse("lin_api_123"), None);
        assert!(tokens(&json!({ "error": "invalid_grant" }), "Linear", 0).unwrap_err().contains("invalid_grant"));
        assert_eq!(poll(&json!({ "error": "authorization_pending" }), 5, "GitHub", 0), Poll::Wait(5));
        assert_eq!(poll(&json!({ "error": "slow_down", "interval": 10 }), 5, "GitHub", 0), Poll::Wait(10));
        assert_eq!(poll(&json!({ "error": "access_denied" }), 5, "GitHub", 0), Poll::Done(Err("GitHub sign-in was cancelled.".into())));
        assert!(matches!(poll(&json!({ "error": "expired_token" }), 5, "GitHub", 0), Poll::Done(Err(_))));
        assert_eq!(poll(&json!({ "access_token": "g", "token_type": "bearer" }), 5, "GitHub", 0), Poll::Done(Ok(Tokens { access: "g".into(), refresh: None, expires_at: None })));
    }
}
