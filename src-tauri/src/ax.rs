//! What a browser shows on screen, read through macOS Accessibility, for call detection (`calls`):
//! its windows' titles and addresses and its tabs' titles, so a meeting in a browser can be told
//! from other microphone use. Only while the user allows it (System Settings → Accessibility, and
//! the setting in QuietNote); nothing read here is stored or sent.
use objc2_app_kit::NSRunningApplication;
use objc2_application_services::{AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElement, kAXTrustedCheckOptionPrompt};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType, Type};
use objc2_foundation::NSString;
use std::ptr::NonNull;

/// How long one Accessibility request may take before it's given up (an app that's busy or hung).
const TIMEOUT_S: f32 = 0.5;
/// Elements looked at per window at most while looking for its tabs.
const BUDGET: usize = 600;
/// Tabs sit some levels below their window: Chrome's are radio buttons about eleven down, inside its
/// tab group's scroll area.
const DEPTH: usize = 14;

/// Whether QuietNote may use Accessibility.
pub fn trusted() -> bool { unsafe { AXIsProcessTrusted() } }
/// Asks macOS to let QuietNote use Accessibility (it shows its own prompt the first time); returns whether it may.
pub fn ask() -> bool {
    let key: &CFString = unsafe { kAXTrustedCheckOptionPrompt };
    let options = CFDictionary::<CFString, CFBoolean>::from_slices(&[key], &[CFBoolean::new(true)]);
    unsafe { AXIsProcessTrustedWithOptions(Some(options.as_opaque())) }
}

fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let mut value: *const CFType = std::ptr::null();
    let status = unsafe { element.copy_attribute_value(&CFString::from_str(name), NonNull::from(&mut value)) };
    if status != AXError::Success || value.is_null() { return None; }
    Some(unsafe { CFRetained::from_raw(NonNull::new_unchecked(value as *mut CFType)) })
}
fn text(element: &AXUIElement, name: &str) -> Option<String> {
    attribute(element, name)?.downcast::<CFString>().ok().map(|s| s.to_string()).filter(|s| !s.trim().is_empty())
}
fn elements(element: &AXUIElement, name: &str) -> Vec<CFRetained<AXUIElement>> {
    let Some(array) = attribute(element, name).and_then(|v| v.downcast::<CFArray>().ok()) else { return Vec::new() };
    let array: &CFArray<CFType> = unsafe { array.cast_unchecked() };
    array.iter().filter_map(|item| item.downcast::<AXUIElement>().ok()).collect()
}
fn apps(bundle_id: &str) -> Vec<CFRetained<AXUIElement>> {
    NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id)).iter().map(|app| {
        let element = unsafe { AXUIElement::new_application(app.processIdentifier()) };
        unsafe { element.set_messaging_timeout(TIMEOUT_S) };
        element
    }).collect()
}
/// The titles of `bundle_id`'s windows, their addresses (where the app reports one) and their tabs.
pub fn titles(bundle_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    for app in apps(bundle_id) {
        for window in elements(&app, "AXWindows") {
            out.extend(text(&window, "AXTitle"));
            out.extend(text(&window, "AXDocument"));
            tabs(&window, &mut out);
        }
    }
    out
}
/// Tab titles: the radio buttons anywhere inside a tab group (named by their title, or by their
/// description in Chrome), looked for breadth-first within a budget.
fn tabs(window: &AXUIElement, out: &mut Vec<String>) {
    let mut level = vec![(window.retain(), false)];
    let mut seen = 0;
    for _ in 0..DEPTH {
        let mut next = Vec::new();
        for (element, inside) in &level {
            let inside = *inside || text(element, "AXRole").as_deref() == Some("AXTabGroup");
            for child in elements(element, "AXChildren") {
                seen += 1;
                if inside && text(&child, "AXRole").as_deref() == Some("AXRadioButton") {
                    out.extend(text(&child, "AXTitle").or_else(|| text(&child, "AXDescription")));
                } else {
                    next.push((child, inside));
                }
                if seen >= BUDGET { return; }
            }
        }
        if next.is_empty() { return; }
        level = next;
    }
}

/// The element tree of a running app, as `role "title" (description)` lines, for working out how a
/// call app shows who is speaking. Diagnostic only; see `calls::tests::call_window_live`.
#[cfg(test)]
pub fn dump(bundle_id: &str, depth: usize) -> String {
    fn walk(element: &AXUIElement, depth: usize, indent: usize, out: &mut String) {
        let field = |name| text(element, name).unwrap_or_default();
        out.push_str(&format!("{}{} {:?} ({}) {}\n", "  ".repeat(indent), field("AXRole"), field("AXTitle"), field("AXDescription"), field("AXValue").chars().take(60).collect::<String>()));
        if depth == 0 { return; }
        for child in elements(element, "AXChildren") { walk(&child, depth - 1, indent + 1, out); }
    }
    let mut out = String::new();
    for app in apps(bundle_id) { for window in elements(&app, "AXWindows") { walk(&window, depth, 0, &mut out); } }
    out
}
