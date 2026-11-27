// Окно ΒybAi: слушатель хуков на 127.0.0.1:4517 и команды для страницы.
// Слушатель делает то же, что dev/bridge.mjs: те же адреса, ответы и правило свёртки.
mod hooks;
mod usage;

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use tiny_http::{Method, Response};

const PORT: u16 = 4517;
// Длинные строки сворачиваются; то же правило в dev/bridge.mjs. В tool_input лежат патчи и
// содержимое файлов, по которым считаются строки, поэтому вне tool_response порог выше.
const TRIM_RESPONSE: usize = 2048;
const TRIM_OTHER: usize = 65536;
const HEAD: usize = 300;
const BACKLOG: usize = 5000;
const BODY_LIMIT: u64 = 16 << 20;
const MAP_LIMIT: u64 = 512 << 10;

/// Принятые конверты: счётчик и последние BACKLOG штук.
#[derive(Default)]
struct Log {
    seq: u64,
    backlog: VecDeque<Value>,
}

struct Home(PathBuf);
struct ListenerError(Option<String>);
/// Последние лимиты подписки Claude Code: их присылает его строка состояния.
#[derive(Default)]
struct Limits(Option<Value>);

// ── Свёртка длинных строк ────────────────────────────────────────

/// Ответ инструмента сворачиваем сразу, остальное — только если оно огромное.
fn trim_body(body: Value) -> Value {
    match body {
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, v)| {
                    let over = if k == "tool_response" { TRIM_RESPONSE } else { TRIM_OTHER };
                    (k, trim(v, over))
                })
                .collect(),
        ),
        v => trim(v, TRIM_OTHER),
    }
}

/// Сворачивает строки длиннее `over` на любой глубине.
fn trim(v: Value, over: usize) -> Value {
    match v {
        Value::String(s) => trim_string(s, over),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| trim(x, over)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, x)| (k, trim(x, over))).collect()),
        v => v,
    }
}

fn trim_string(s: String, over: usize) -> Value {
    // Длины — как в JS, в единицах UTF-16. Байтов не меньше, чем единиц:
    // строку, короткую в байтах, можно не пересчитывать.
    let chars = if s.len() > over { s.encode_utf16().count() } else { 0 };
    if chars <= over {
        return Value::String(s);
    }
    let lines = s.split('\n').count() - usize::from(s.ends_with('\n'));
    // Начало режем по целым символам.
    let mut taken = 0;
    let head: String = s
        .chars()
        .take_while(|c| {
            taken += c.len_utf16();
            taken <= HEAD
        })
        .collect();
    json!({ "$trim": true, "chars": chars, "lines": lines, "head": head })
}

// ── Слушатель ────────────────────────────────────────────────────

/// Запоминает конверт и отдаёт его странице.
fn accept(app: &tauri::AppHandle, source: &str, replied: usize, body: Value) {
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let env = {
        let log = app.state::<Mutex<Log>>();
        let mut log = log.lock().unwrap();
        log.seq += 1;
        let env = json!({ "seq": log.seq, "at": at, "source": source, "replied": replied, "body": body });
        log.backlog.push_back(env.clone());
        if log.backlog.len() > BACKLOG {
            log.backlog.pop_front();
        }
        env
    };
    let _ = app.emit("hook", env);
}

/// Открывает порт и разбирает запросы в отдельном потоке. Ошибка — причина, по которой порт не открыт.
fn listen(app: tauri::AppHandle) -> Result<(), String> {
    let socket = std::net::TcpListener::bind(("127.0.0.1", PORT)).map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => format!("Порт {PORT} занят: слушатель не запущен"),
        _ => format!("Порт {PORT} не открылся, слушатель не запущен: {e}"),
    })?;
    let server = tiny_http::Server::from_listener(socket, None)
        .map_err(|e| format!("Слушатель на порту {PORT} не запущен: {e}"))?;
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            let source = match (req.method(), req.url()) {
                (Method::Post, "/hook/claude") => Some("claude"),
                (Method::Post, "/hook/codex") => Some("codex"),
                (Method::Post, "/status/claude") => Some("status"),
                _ => None,
            };
            let Some(source) = source else {
                let _ = req.respond(Response::empty(404u16));
                continue;
            };
            // Страница из браузера всегда шлёт Origin; хуки агентов — никогда.
            if req.headers().iter().any(|h| h.field.equiv("Origin")) {
                let _ = req.respond(Response::empty(403u16));
                continue;
            }
            let mut body = Vec::new();
            let _ = req.as_reader().take(BODY_LIMIT).read_to_end(&mut body);
            if source == "status" {
                status_line(&app, req, &body);
                continue;
            }
            // Сначала ответ, потом работа: агент не ждёт. Ответ пустой — ему не уходит ни байта.
            let replied = 0;
            let _ = req.respond(Response::empty(204u16));
            // не JSON — пропускаем
            if let Ok(json) = serde_json::from_slice::<Value>(&body) {
                accept(&app, source, replied, trim_body(json));
            }
        }
    });
    Ok(())
}

/// Строка состояния Claude Code: забираем лимиты подписки и отвечаем текстом строки.
/// Он рисуется в терминале человека и в контекст модели не попадает.
fn status_line(app: &tauri::AppHandle, req: tiny_http::Request, body: &[u8]) {
    let limits = serde_json::from_slice::<Value>(body).ok().and_then(|json| usage::claude_limits(&json["rate_limits"]));
    let text = limits.as_ref().map(usage::limits_text).unwrap_or_default();
    let kind = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/plain; charset=utf-8"[..]).unwrap();
    let _ = req.respond(Response::from_string(text).with_header(kind));
    let state = app.state::<Mutex<Limits>>();
    let mut state = state.lock().unwrap();
    if state.0 != limits {
        state.0 = limits.clone();
        let _ = app.emit("limits", limits);
    }
}

// ── Команды страницы ─────────────────────────────────────────────

/// Всё, что держим в памяти, от старых к новым.
#[tauri::command]
fn backlog(log: tauri::State<'_, Mutex<Log>>) -> Vec<Value> {
    log.lock().unwrap().backlog.iter().cloned().collect()
}

#[tauri::command]
fn hooks_status(home: tauri::State<'_, Home>) -> Value {
    hooks::status(&home.0)
}

#[tauri::command]
fn hooks_set(home: tauri::State<'_, Home>, agent: String, on: bool) -> Result<Value, String> {
    hooks::set(&home.0, &agent, on)
}

/// Причина, по которой слушатель не запущен; None — он работает.
#[tauri::command]
fn listener_error(error: tauri::State<'_, ListenerError>) -> Option<String> {
    error.0.clone()
}

/// Схема проекта, которую написал агент: <cwd>/.bybai/map.json. None — файла нет или он слишком велик.
#[tauri::command]
fn read_map(cwd: String) -> Option<String> {
    let file = std::path::Path::new(&cwd).join(".bybai").join("map.json");
    if std::fs::metadata(&file).ok()?.len() > MAP_LIMIT {
        return None;
    }
    std::fs::read_to_string(file).ok()
}

// ── Свои файлы: настройки окна и статистика проектов ─────────────

const STORES: &[&str] = &["settings", "projects"];

fn store_file(home: &Path, name: &str) -> Option<PathBuf> {
    STORES.contains(&name).then(|| home.join(".bybai").join(format!("{name}.json")))
}

#[tauri::command]
fn store_read(home: tauri::State<'_, Home>, name: String) -> Option<String> {
    std::fs::read_to_string(store_file(&home.0, &name)?).ok()
}

/// Пишет рядом временный файл и переименовывает: половину файла никто не прочитает.
#[tauri::command]
fn store_write(home: tauri::State<'_, Home>, name: String, text: String) -> Result<(), String> {
    let file = store_file(&home.0, &name).ok_or("Неизвестное хранилище")?;
    let tmp = file.with_extension("tmp");
    std::fs::create_dir_all(home.0.join(".bybai"))
        .and_then(|_| std::fs::write(&tmp, text))
        .and_then(|_| std::fs::rename(&tmp, &file))
        .map_err(|e| format!("Не удалось записать {}: {e}", file.display()))
}

/// Расход сессии агента из его журнала на диске; None — журнал не найден.
#[tauri::command(async)]
fn usage(
    home: tauri::State<'_, Home>,
    scans: tauri::State<'_, Mutex<usage::Scans>>,
    source: String,
    sid: String,
    transcript: Option<String>,
    tz: i64,
) -> Option<Value> {
    scans.lock().unwrap().usage(&home.0, &source, &sid, transcript.as_deref(), tz)
}

#[tauri::command]
fn limits(limits: tauri::State<'_, Mutex<Limits>>) -> Option<Value> {
    limits.lock().unwrap().0.clone()
}

/// Возвращает главное окно на экран: повторный запуск и щелчок по плашке.
#[tauri::command]
fn show_main(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // Плагин одного экземпляра должен идти первым: повторный запуск показывает уже открытое окно.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app.clone())))
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // Плашка поверх экранов живёт, пока главное окно свёрнуто.
                tauri::WindowEvent::Resized(_) => {
                    let minimized = window.is_minimized().unwrap_or(false);
                    let _ = window.app_handle().emit_to("hud", "minimized", minimized);
                }
                // Окно плашки скрыто и само приложение не завершит.
                tauri::WindowEvent::Destroyed => window.app_handle().exit(0),
                _ => {}
            }
        })
        .setup(|app| {
            // BYBAI_HOME подменяет домашний каталог: проверки не трогают настоящие настройки агентов.
            let home = match std::env::var_os("BYBAI_HOME") {
                Some(dir) => PathBuf::from(dir),
                None => app.path().home_dir()?,
            };
            app.manage(Mutex::new(Log::default()));
            app.manage(Mutex::new(usage::Scans::default()));
            app.manage(Mutex::new(Limits::default()));
            // Занятый порт — не повод не запускаться: причину отдаёт listener_error.
            let error = listen(app.handle().clone()).err();
            app.manage(ListenerError(error));
            // Хуки стоят в настройках агентов, только пока приложение работает.
            hooks::sync(&home, true);
            app.manage(Home(home));
            // Окна создаём сами и последними ("create": false в tauri.conf.json): страница вызывает
            // команды сразу после загрузки, и к этому времени состояние должно быть готово.
            for window in app.config().app.windows.clone() {
                tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?.build()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backlog, hooks_status, hooks_set, listener_error, read_map, store_read, store_write, usage, limits, show_main
        ])
        .build(tauri::generate_context!())
        .expect("приложение не запустилось");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event
            && let Some(home) = app.try_state::<Home>()
        {
            hooks::sync(&home.0, false);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trimmed(chars: usize, lines: usize, head: &str) -> Value {
        json!({ "$trim": true, "chars": chars, "lines": lines, "head": head })
    }

    #[test]
    fn short_values_are_untouched() {
        let body = json!({ "tool_response": "a".repeat(2048), "n": 1, "ok": true, "none": null });
        assert_eq!(trim_body(body.clone()), body);
    }

    #[test]
    fn long_string_is_folded() {
        let out = trim("a".repeat(2049).into(), 2048);
        assert_eq!(out, trimmed(2049, 1, &"a".repeat(300)));
        // порядок ключей тот же, что у моста
        assert!(out.to_string().starts_with(r#"{"$trim":true,"chars":2049,"lines":1,"head":"#));
    }

    #[test]
    fn nested_strings_are_folded() {
        let long = "b".repeat(3000);
        let body = json!({ "tool_response": { "z": [1, { "out": long }, "short"], "a": "keep" } });
        let out = trim_body(body);
        assert_eq!(
            out,
            json!({ "tool_response": { "z": [1, { "out": trimmed(3000, 1, &"b".repeat(300)) }, "short"], "a": "keep" } })
        );
        assert!(out.to_string().starts_with(r#"{"tool_response":{"z":"#));
    }

    #[test]
    fn limit_depends_on_place() {
        let mid = "c".repeat(3000);
        let huge = "d".repeat(65537);
        let body = json!({
            "tool_input": { "content": mid, "patch": huge },
            "tool_response": { "stdout": mid },
            "prompt": "e".repeat(65536),
        });
        let out = trim_body(body);
        // вне tool_response порог 65536
        assert_eq!(out["tool_input"]["content"], mid.as_str());
        assert_eq!(out["tool_input"]["patch"], trimmed(65537, 1, &"d".repeat(300)));
        assert_eq!(out["prompt"], "e".repeat(65536).as_str());
        // внутри tool_response порог 2048
        assert_eq!(out["tool_response"]["stdout"], trimmed(3000, 1, &"c".repeat(300)));
        // tool_response может быть и просто строкой
        let out = trim_body(json!({ "tool_response": mid }));
        assert_eq!(out["tool_response"], trimmed(3000, 1, &"c".repeat(300)));
        // тело не объект — общий порог
        assert_eq!(trim_body(json!(mid)), mid.as_str());
    }

    #[test]
    fn trailing_newline_is_not_a_line() {
        let text = "x\n".repeat(1500);
        assert_eq!(trim(text.clone().into(), 2048)["lines"], 1500);
        assert_eq!(trim((text + "y").into(), 2048)["lines"], 1501);
    }

    #[test]
    fn head_is_cut_on_char_boundary() {
        // кириллица: 2 байта на символ, 1 единица UTF-16
        let out = trim("ж".repeat(3000).into(), 2048);
        assert_eq!(out, trimmed(3000, 1, &"ж".repeat(300)));
        // порог считается не в байтах: 2048 символов — ещё не длинная строка
        let exact = "ж".repeat(2048);
        assert_eq!(trim(exact.clone().into(), 2048), exact.as_str());
        // эмодзи: 2 единицы UTF-16, как в JS
        let out = trim("🙂".repeat(1500).into(), 2048);
        assert_eq!(out, trimmed(3000, 1, &"🙂".repeat(150)));
        // пара не разрывается: 1 + 149·2 = 299 единиц
        let out = trim(("a".to_string() + &"🙂".repeat(1500)).into(), 2048);
        assert_eq!(out["head"], ("a".to_string() + &"🙂".repeat(149)).as_str());
    }
}
