// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `quietnote meetings`, `quietnote show …`: the read-only command-line tool, without starting the app.
    if let Some(code) = scratch_lib::command_line(&std::env::args().collect::<Vec<_>>()) { std::process::exit(code); }
    scratch_lib::run()
}
