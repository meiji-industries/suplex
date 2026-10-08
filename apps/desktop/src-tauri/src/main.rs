// A release build on Windows is a GUI program: no console window opens behind it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    suplex_desktop::run()
}
