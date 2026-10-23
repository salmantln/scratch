//! The compact meeting window. Recording a call from the "Meeting detected" panel turns the main
//! window into a narrow column beside the call, holding only the meeting (notes, recorder, live
//! transcript), like a notepad next to the call rather than the whole app over it. Leaving it puts the
//! window back where and how big it was.
use std::sync::Mutex;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize};

/// The column's width, and its distance from the screen's edges (points).
const WIDTH: f64 = 420.0;
const MARGIN: f64 = 12.0;
/// The window's minimum size normally (as in `tauri.conf.json`) and while compact.
const MIN: (f64, f64) = (600.0, 540.0);
const COMPACT_MIN: (f64, f64) = (360.0, 480.0);

/// The full window's frame, kept while compact so it can be restored.
#[derive(Default)]
pub struct Compact(Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>);

/// Where the column goes in a screen's usable area (physical pixels): full height at the right edge.
fn column(area: (i32, i32, u32, u32), scale: f64) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let (x, y, width, height) = area;
    let (w, margin) = ((WIDTH * scale) as u32, (MARGIN * scale) as u32);
    let size = PhysicalSize::new(w.min(width), height.saturating_sub(2 * margin));
    (PhysicalPosition::new(x + width.saturating_sub(size.width + margin) as i32, y + margin as i32), size)
}

fn enter(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    let saved = app.state::<Compact>();
    if let Ok(mut saved) = saved.0.lock() {
        if saved.is_none() && !window.is_fullscreen()? { *saved = Some((window.outer_position()?, window.inner_size()?)); }
    }
    window.set_fullscreen(false)?;
    window.unmaximize()?;
    window.set_min_size(Some(LogicalSize::new(COMPACT_MIN.0, COMPACT_MIN.1)))?;
    // The screen the pointer is on: the one where Start recording was just clicked, beside the call.
    let monitor = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or(window.current_monitor()?);
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let (position, size) = column((area.position.x, area.position.y, area.size.width, area.size.height), monitor.scale_factor());
        window.set_size(size)?;
        window.set_position(position)?;
    }
    Ok(())
}
fn leave(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    window.set_min_size(Some(LogicalSize::new(MIN.0, MIN.1)))?;
    let saved = app.state::<Compact>().0.lock().ok().and_then(|mut s| s.take());
    match saved {
        Some((position, size)) => { window.set_size(size)?; window.set_position(position)?; }
        None => { window.set_size(LogicalSize::new(1280.0, 850.0))?; window.center()?; }
    }
    Ok(())
}
/// Makes the main window the compact column beside the call, or puts it back.
#[tauri::command]
pub fn window_compact(app: AppHandle, compact: bool) -> Result<(), String> {
    if compact { enter(&app) } else { leave(&app) }.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_column_fills_the_right_edge_of_the_screen() {
        // A 1512 × 944 pt screen at 2×, under a 33 pt menu bar.
        let (position, size) = column((0, 66, 3024, 1888), 2.0);
        assert_eq!((size.width, size.height), (840, 1840));
        assert_eq!((position.x, position.y), (3024 - 840 - 24, 66 + 24));
        // A second screen to the left, and a screen narrower than the column.
        let (position, _) = column((-1920, 0, 1920, 1080), 1.0);
        assert_eq!(position.x, -420 - 12);
        assert_eq!(column((0, 0, 300, 600), 1.0).1.width, 300);
    }
}
