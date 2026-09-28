// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if let Some(code) = perfect_planner_desktop_lib::run_task_stdio_if_requested() {
        std::process::exit(code);
    }
    if let Some(code) = perfect_planner_desktop_lib::run_stdio_if_requested() {
        std::process::exit(code);
    }
    perfect_planner_desktop_lib::run();
}
