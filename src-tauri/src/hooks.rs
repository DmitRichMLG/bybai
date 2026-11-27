// Хуки агентов: что и куда ставим, сохранённый выбор и правка файлов настроек.
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

/// По этой подстроке в url или command узнаём свои записи.
const MARKER: &str = "127.0.0.1:4517/hook/";

// ── Codex ────────────────────────────────────────────────────────
// Файл разбирается строго: в корне допустимы только description и hooks.
const CODEX_FILE: &str = ".codex/hooks.json";
const CODEX_EVENTS: &[&str] =
    &["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"];
// Codex хеширует команду, чтобы доверять хуку: строка не должна меняться от установки к установке.
const CODEX_COMMAND: &str = r#"cmd.exe /d /s /c "curl.exe -s -o NUL -m 1 --noproxy 127.0.0.1 -H Content-Type:application/json --data-binary @- http://127.0.0.1:4517/hook/codex & exit /b 0""#;
fn codex_entry() -> Value {
    json!({ "type": "command", "async": true, "timeout": 5, "command": CODEX_COMMAND })
}

// ── Claude Code ──────────────────────────────────────────────────
const CLAUDE_FILE: &str = ".claude/settings.json";
const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "Stop",
    "SessionEnd",
];
fn claude_entry() -> Value {
    json!({ "type": "http", "url": "http://127.0.0.1:4517/hook/claude", "timeout": 1 })
}

// ── Выбор пользователя ───────────────────────────────────────────

/// Лежит в домашнем каталоге: { "claude": bool, "codex": bool }.
const PREFS_FILE: &str = ".bybai.json";

/// Сохранённый выбор. Нет файла — оба агента выключены.
pub fn status(home: &Path) -> Value {
    let saved = fs::read_to_string(home.join(PREFS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_default();
    let on = |agent: &str| saved[agent] == true;
    json!({ "claude": on("claude"), "codex": on("codex") })
}

/// Ставит или снимает хуки агента и запоминает выбор. Возвращает новый выбор.
pub fn set(home: &Path, agent: &str, on: bool) -> Result<Value, String> {
    apply(home, agent, on)?;
    let mut prefs = status(home);
    prefs[agent] = on.into();
    write_atomic(&home.join(PREFS_FILE), &prefs)?;
    Ok(prefs)
}

/// Ставит (запуск) или снимает (выход) хуки включённых агентов. Сам выбор не меняется.
pub fn sync(home: &Path, on: bool) {
    let prefs = status(home);
    for agent in ["claude", "codex"] {
        if prefs[agent] == true
            && let Err(why) = apply(home, agent, on)
        {
            eprintln!("{why}");
        }
    }
}

fn apply(home: &Path, agent: &str, on: bool) -> Result<(), String> {
    let (file, events, entry) = match agent {
        "claude" => (CLAUDE_FILE, CLAUDE_EVENTS, claude_entry()),
        "codex" => (CODEX_FILE, CODEX_EVENTS, codex_entry()),
        _ => return Err(format!("Неизвестный агент: {agent}")),
    };
    // components() приводит разделители пути к системным
    let file: PathBuf = home.join(file).components().collect();
    set_hooks(&file, events, &entry, on)
}

// ── Файл настроек агента ─────────────────────────────────────────
// Форма одна для обоих: { "hooks": { "<Событие>": [ { "hooks": [ запись, … ] }, … ] } }

/// Добавляет запись в каждое событие или убирает все свои записи. Остальное в файле не меняется.
pub fn set_hooks(file: &Path, events: &[&str], entry: &Value, on: bool) -> Result<(), String> {
    let name = file.display();
    let text = match fs::read_to_string(file) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Не удалось прочитать {name}: {e}")),
    };
    let mut root = match &text {
        Some(text) => serde_json::from_str::<Value>(text)
            .map_err(|e| format!("{name}: это не JSON, файл оставлен как есть ({e})"))?,
        None if on => json!({}),
        None => return Ok(()),
    };
    let Some(settings) = root.as_object_mut() else {
        return Err(format!("{name}: в корне ожидался объект, файл оставлен как есть"));
    };
    let changed = if on {
        install(settings, events, entry)
            .ok_or_else(|| format!("{name}: раздел hooks устроен непривычно, файл оставлен как есть"))?
    } else {
        uninstall(settings)
    };
    let emptied = !on && settings.is_empty();
    if !changed {
        return Ok(());
    }
    // Копия делается перед первой установкой в чужой файл. Нет копии — файл создали мы сами:
    // когда в нём ничего не осталось, убираем его, а не оставляем пустой объект.
    if emptied && !with_suffix(file, BACKUP).exists() {
        return fs::remove_file(file).map_err(|e| format!("Не удалось удалить {name}: {e}"));
    }
    if text.is_some() {
        if on {
            backup(file)?;
        }
    } else if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать каталог {}: {e}", dir.display()))?;
    }
    write_atomic(file, &root)
}

fn is_ours(entry: &Value) -> bool {
    ["url", "command"]
        .iter()
        .any(|key| entry.get(key).and_then(Value::as_str).is_some_and(|s| s.contains(MARKER)))
}

/// Записи одной группы: { "hooks": [ запись, … ] }.
fn entries(group: &Value) -> impl Iterator<Item = &Value> {
    group.get("hooks").and_then(Value::as_array).into_iter().flatten()
}

/// Было ли что добавлять. None — раздел hooks не той формы.
fn install(settings: &mut Map<String, Value>, events: &[&str], entry: &Value) -> Option<bool> {
    let hooks = settings.entry("hooks").or_insert_with(|| json!({})).as_object_mut()?;
    let mut changed = false;
    for event in events {
        let groups = hooks.entry(*event).or_insert_with(|| json!([])).as_array_mut()?;
        if !groups.iter().flat_map(entries).any(is_ours) {
            groups.push(json!({ "hooks": [entry] }));
            changed = true;
        }
    }
    Some(changed)
}

/// Было ли что убирать. Вслед за записями уходит только то, что из-за них опустело.
fn uninstall(settings: &mut Map<String, Value>) -> bool {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return false;
    };
    let mut changed = false;
    hooks.retain(|_, groups| {
        let Some(groups) = groups.as_array_mut() else {
            return true;
        };
        let had_groups = !groups.is_empty();
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let had = list.len();
            list.retain(|entry| !is_ours(entry));
            changed |= list.len() < had;
            had == 0 || !list.is_empty()
        });
        !had_groups || !groups.is_empty()
    });
    if changed && hooks.is_empty() {
        // shift_remove не переставляет остальные ключи
        settings.shift_remove("hooks");
    }
    changed
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

const BACKUP: &str = ".bybai-backup";

/// Копия до первой правки; существующую копию не трогаем.
fn backup(file: &Path) -> Result<(), String> {
    let copy = with_suffix(file, BACKUP);
    if copy.exists() {
        return Ok(());
    }
    fs::copy(file, &copy)
        .map(drop)
        .map_err(|e| format!("Не удалось сохранить копию {}: {e}", copy.display()))
}

/// Пишет рядом временный файл и переименовывает: читатель не увидит половину файла.
fn write_atomic(file: &Path, value: &Value) -> Result<(), String> {
    let tmp = with_suffix(file, ".bybai-tmp");
    fs::write(&tmp, format!("{value:#}\n")).and_then(|_| fs::rename(&tmp, file)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Не удалось записать {}: {e}", file.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Временный каталог теста; настоящий домашний каталог тесты не трогают.
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(name: &str) -> Tmp {
            let dir = std::env::temp_dir().join(format!("bybai-test-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const OURS: &str = r#"{"type":"http","url":"http://127.0.0.1:4517/hook/claude","timeout":1}"#;
    const THEIRS: &str = r#"{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}"#;

    /// Записывает JSON в том виде, в каком его оставляет set_hooks, и возвращает текст.
    fn write(file: &Path, json: &str) -> String {
        let text = format!("{:#}\n", serde_json::from_str::<Value>(json).unwrap());
        fs::write(file, &text).unwrap();
        text
    }

    fn read(file: &Path) -> String {
        fs::read_to_string(file).unwrap()
    }

    /// Содержимое файла одной строкой; порядок ключей сохраняется.
    fn compact(file: &Path) -> String {
        serde_json::from_str::<Value>(&read(file)).unwrap().to_string()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        names
    }

    #[test]
    fn install_into_missing_file() {
        let tmp = Tmp::new("missing");
        let file = tmp.0.join(".claude").join("settings.json");
        set_hooks(&file, &["Stop"], &claude_entry(), true).unwrap();
        let expected = r#"{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:4517/hook/claude",
            "timeout": 1
          }
        ]
      }
    ]
  }
}
"#;
        assert_eq!(read(&file), expected);
        // копировать было нечего, временный файл не остался
        assert_eq!(names(file.parent().unwrap()), ["settings.json"]);
    }

    #[test]
    fn install_keeps_everything_else() {
        let tmp = Tmp::new("keeps");
        let file = tmp.0.join("settings.json");
        write(
            &file,
            &format!(r#"{{"zeta":1,"model":"opus","hooks":{{"PreToolUse":[{THEIRS}]}},"alpha":{{"b":[1,2],"a":null}}}}"#),
        );
        set_hooks(&file, &["PreToolUse", "Stop"], &claude_entry(), true).unwrap();
        assert_eq!(
            compact(&file),
            format!(
                r#"{{"zeta":1,"model":"opus","hooks":{{"PreToolUse":[{THEIRS},{{"hooks":[{OURS}]}}],"Stop":[{{"hooks":[{OURS}]}}]}},"alpha":{{"b":[1,2],"a":null}}}}"#
            )
        );
        assert!(read(&file).ends_with("}\n"));
    }

    #[test]
    fn install_is_idempotent() {
        let tmp = Tmp::new("idempotent");
        let file = tmp.0.join("settings.json");
        write(&file, r#"{"model":"opus"}"#);
        set_hooks(&file, &["Stop", "PreToolUse"], &claude_entry(), true).unwrap();
        let once = read(&file);
        set_hooks(&file, &["Stop", "PreToolUse"], &claude_entry(), true).unwrap();
        assert_eq!(read(&file), once);
        assert_eq!(once.matches(MARKER).count(), 2);
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let tmp = Tmp::new("uninstall");
        let file = tmp.0.join("settings.json");
        // установка и снятие возвращают файл к исходному тексту
        let before = write(&file, &format!(r#"{{"model":"opus","hooks":{{"PreToolUse":[{THEIRS}]}},"last":true}}"#));
        set_hooks(&file, &["PreToolUse", "Stop"], &claude_entry(), true).unwrap();
        set_hooks(&file, &[], &claude_entry(), false).unwrap();
        assert_eq!(read(&file), before);

        // наша запись в чужой группе: группа остаётся; что было пустым до нас — тоже
        write(
            &file,
            &format!(
                r#"{{"hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"echo mine"}},{OURS}]}}],"Notification":[],"SessionEnd":[{{"hooks":[]}}],"PreToolUse":[{{"hooks":[{OURS}]}}]}},"model":"opus"}}"#
            ),
        );
        set_hooks(&file, &[], &claude_entry(), false).unwrap();
        assert_eq!(
            compact(&file),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}],"Notification":[],"SessionEnd":[{"hooks":[]}]},"model":"opus"}"#
        );
    }

    #[test]
    fn uninstall_drops_what_became_empty() {
        let tmp = Tmp::new("empties");
        let file = tmp.0.join("settings.json");
        write(
            &file,
            &format!(r#"{{"a":1,"hooks":{{"Stop":[{{"hooks":[{OURS}]}}],"PreToolUse":[{{"hooks":[{OURS}]}}]}},"b":2,"c":3}}"#),
        );
        set_hooks(&file, &[], &claude_entry(), false).unwrap();
        assert_eq!(read(&file), "{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3\n}\n");
    }

    #[test]
    fn uninstall_without_file_does_nothing() {
        let tmp = Tmp::new("nofile");
        let file = tmp.0.join(".claude").join("settings.json");
        set_hooks(&file, &["Stop"], &claude_entry(), false).unwrap();
        assert!(names(&tmp.0).is_empty());
    }

    #[test]
    fn invalid_json_is_refused() {
        let tmp = Tmp::new("invalid");
        let file = tmp.0.join("settings.json");
        for text in ["{ \"model\": \"opus\", ", "[1, 2]", r#"{"hooks":[]}"#, r#"{"hooks":{"Stop":{}}}"#] {
            fs::write(&file, text).unwrap();
            assert!(set_hooks(&file, &["Stop"], &claude_entry(), true).is_err(), "{text}");
            assert_eq!(read(&file), text);
        }
        fs::write(&file, "не JSON").unwrap();
        assert!(set_hooks(&file, &["Stop"], &claude_entry(), false).is_err());
        assert_eq!(read(&file), "не JSON");
        // ни копии, ни временного файла
        assert_eq!(names(&tmp.0), ["settings.json"]);
    }

    #[test]
    fn backup_is_made_once() {
        let tmp = Tmp::new("backup");
        let file = tmp.0.join("settings.json");
        let copy = tmp.0.join("settings.json.bybai-backup");
        let before = write(&file, r#"{"model":"opus"}"#);
        set_hooks(&file, &["Stop"], &claude_entry(), true).unwrap();
        assert_eq!(read(&copy), before);
        // следующая правка копию не перезаписывает
        set_hooks(&file, &[], &claude_entry(), false).unwrap();
        assert_eq!(read(&copy), before);
        assert_eq!(names(&tmp.0), ["settings.json", "settings.json.bybai-backup"]);
    }

    #[test]
    fn claude_in_temp_home() {
        let home = Tmp::new("home-claude");
        let file = home.0.join(".claude").join("settings.json");
        assert_eq!(status(&home.0), json!({ "claude": false, "codex": false }));
        assert!(set(&home.0, "gemini", true).is_err());
        assert!(names(&home.0).is_empty());

        assert_eq!(set(&home.0, "claude", true).unwrap(), json!({ "claude": true, "codex": false }));
        assert_eq!(read(&home.0.join(PREFS_FILE)), "{\n  \"claude\": true,\n  \"codex\": false\n}\n");
        let installed = read(&file);
        for event in CLAUDE_EVENTS {
            assert!(installed.contains(&format!("\"{event}\"")), "{event}");
        }
        assert_eq!(installed.matches(MARKER).count(), CLAUDE_EVENTS.len());

        // выход снимает хуки, выбор остаётся; запуск ставит их снова.
        // Файл создали мы сами, поэтому без хуков он исчезает, а копии нет.
        sync(&home.0, false);
        assert!(!file.exists());
        assert_eq!(status(&home.0), json!({ "claude": true, "codex": false }));
        sync(&home.0, true);
        assert_eq!(read(&file), installed);

        assert_eq!(set(&home.0, "claude", false).unwrap(), json!({ "claude": false, "codex": false }));
        assert!(names(file.parent().unwrap()).is_empty());
        assert!(!home.0.join(".codex").exists());
    }

    #[test]
    fn empty_file_of_the_user_survives() {
        let tmp = Tmp::new("user-empty");
        let file = tmp.0.join("hooks.json");
        // пустой объект был у человека до нас: после снятия он остаётся, копия хранит оригинал
        fs::write(&file, "{}\n").unwrap();
        set_hooks(&file, &["Stop"], &codex_entry(), true).unwrap();
        set_hooks(&file, &[], &codex_entry(), false).unwrap();
        assert_eq!(read(&file), "{}\n");
        assert_eq!(read(&tmp.0.join("hooks.json.bybai-backup")), "{}\n");
    }

    #[test]
    fn uninstall_alone_makes_no_backup() {
        let tmp = Tmp::new("no-backup");
        let file = tmp.0.join("settings.json");
        // наши записи остались с прошлого запуска: снятие не выдаёт их за оригинал
        write(&file, &format!(r#"{{"model":"opus","hooks":{{"Stop":[{{"hooks":[{OURS}]}}]}}}}"#));
        set_hooks(&file, &[], &claude_entry(), false).unwrap();
        assert_eq!(compact(&file), r#"{"model":"opus"}"#);
        assert_eq!(names(&tmp.0), ["settings.json"]);
    }

    #[test]
    fn codex_in_temp_home() {
        let home = Tmp::new("home-codex");
        let file = home.0.join(".codex").join("hooks.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        // чужая группа с matcher и описание должны пережить установку и снятие
        let foreign = r#"{"matcher":"shell","hooks":[{"type":"command","command":"echo theirs"}]}"#;
        let before = write(&file, &format!(r#"{{"description":"мои хуки","hooks":{{"PreToolUse":[{foreign}]}}}}"#));

        assert_eq!(set(&home.0, "codex", true).unwrap(), json!({ "claude": false, "codex": true }));
        let installed: Value = serde_json::from_str(&read(&file)).unwrap();
        // в корне Codex допускает только description и hooks
        assert_eq!(installed.as_object().unwrap().keys().collect::<Vec<_>>(), ["description", "hooks"]);
        assert_eq!(installed["hooks"].as_object().unwrap().len(), CODEX_EVENTS.len());
        for event in CODEX_EVENTS {
            let groups = installed["hooks"][event].as_array().unwrap();
            assert_eq!(groups.last().unwrap(), &json!({ "hooks": [codex_entry()] }), "{event}");
        }
        let foreign: Value = serde_json::from_str(foreign).unwrap();
        assert_eq!(installed["hooks"]["PreToolUse"], json!([foreign, { "hooks": [codex_entry()] }]));

        assert_eq!(set(&home.0, "codex", false).unwrap(), json!({ "claude": false, "codex": false }));
        assert_eq!(read(&file), before);
        assert!(!home.0.join(".claude").exists());
    }

    #[test]
    fn codex_entry_is_byte_stable() {
        assert_eq!(
            codex_entry().to_string(),
            r#"{"type":"command","async":true,"timeout":5,"command":"cmd.exe /d /s /c \"curl.exe -s -o NUL -m 1 --noproxy 127.0.0.1 -H Content-Type:application/json --data-binary @- http://127.0.0.1:4517/hook/codex & exit /b 0\""}"#
        );
        assert!(is_ours(&codex_entry()) && is_ours(&claude_entry()));
    }
}
