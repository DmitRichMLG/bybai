// В выпускной сборке не открываем консольное окно.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bybai_lib::run()
}
