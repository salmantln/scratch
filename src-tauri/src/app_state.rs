//! Small state shared by the tray and the main window, available while the window is hidden.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Default)]
pub struct Shared {
    quitting: AtomicBool,
    project: Mutex<Option<String>>,
}
impl Shared {
    pub fn quitting(&self) -> bool { self.quitting.load(Ordering::SeqCst) }
    /// Marks the app as quitting. Returns false when a quit was already in progress.
    pub fn begin_quit(&self) -> bool { !self.quitting.swap(true, Ordering::SeqCst) }
    pub fn project(&self) -> Option<String> { self.project.lock().ok().and_then(|p| p.clone()) }
    pub fn set_project(&self, project: Option<String>) { if let Ok(mut p) = self.project.lock() { *p = project; } }
}
