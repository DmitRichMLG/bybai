// Расход агента: читаем журналы сессий, которые Claude Code и Codex сами пишут на диск.
// Агенту это не стоит ничего — окно только читает файлы.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

/// Сколько читаем за один раз; остаток дочитается следующим вызовом.
const CHUNK: u64 = 64 << 20;

/// Вход без кэша, кэш (чтение и запись), выход.
type Tokens = [u64; 3];

/// Продолжаемое чтение одного журнала: помним, докуда дочитали.
#[derive(Default)]
pub struct Scan {
    offset: u64,
    /// Claude Code пишет одно сообщение модели несколькими строками с одним id: в счёт идёт последняя.
    messages: HashMap<String, (i64, Tokens)>,
    /// Codex присылает нарастающий итог сессии.
    total: Tokens,
    days: HashMap<i64, u64>,
    limits: Option<Value>,
}

/// Журналы по путям и найденные файлы сессий Codex.
#[derive(Default)]
pub struct Scans {
    files: HashMap<PathBuf, Scan>,
    rollouts: HashMap<String, PathBuf>,
}

impl Scans {
    /// Расход сессии или None, если её журнал не найден. tz — сколько минут прибавить к UTC.
    pub fn usage(&mut self, home: &Path, source: &str, sid: &str, transcript: Option<&str>, tz: i64) -> Option<Value> {
        let codex = source == "codex";
        let file = if codex {
            self.rollout(home, sid)?
        } else {
            // Путь присылает хук; читаем только журналы из каталога самого Claude Code.
            let file = PathBuf::from(transcript?);
            let inside = file.starts_with(home.join(".claude")) && file.extension().is_some_and(|e| e == "jsonl");
            if !inside {
                return None;
            }
            file
        };
        let scan = self.files.entry(file.clone()).or_default();
        scan.read(&file, codex, tz).ok()?;
        Some(scan.report(codex))
    }

    /// Журнал сессии Codex: ~/.codex/sessions/ГГГГ/ММ/ДД/rollout-<время>-<сессия>.jsonl.
    fn rollout(&mut self, home: &Path, sid: &str) -> Option<PathBuf> {
        if let Some(file) = self.rollouts.get(sid) {
            return Some(file.clone());
        }
        if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        let tail = format!("-{sid}.jsonl");
        let file = newest_first(&home.join(".codex").join("sessions"))
            .into_iter()
            .flat_map(|year| newest_first(&year))
            .flat_map(|month| newest_first(&month))
            .flat_map(|day| newest_first(&day))
            .find(|f| f.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&tail)))?;
        self.rollouts.insert(sid.to_string(), file.clone());
        Some(file)
    }
}

fn newest_first(dir: &Path) -> Vec<PathBuf> {
    let mut items: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    items.sort();
    items.reverse();
    items
}

impl Scan {
    /// Дочитывает журнал с места, где остановились в прошлый раз.
    pub fn read(&mut self, file: &Path, codex: bool, tz: i64) -> std::io::Result<()> {
        let mut f = File::open(file)?;
        if f.metadata()?.len() < self.offset {
            *self = Scan::default(); // файл заменили: читаем заново
        }
        f.seek(SeekFrom::Start(self.offset))?;
        let mut buf = Vec::new();
        f.take(CHUNK).read_to_end(&mut buf)?;
        // Последняя строка может быть ещё не дописана: берём только целые.
        let Some(end) = buf.iter().rposition(|b| *b == b'\n') else {
            return Ok(());
        };
        for line in buf[..end].split(|b| *b == b'\n') {
            if codex { self.codex_line(line, tz) } else { self.claude_line(line, tz) }
        }
        self.offset += end as u64 + 1;
        Ok(())
    }

    fn claude_line(&mut self, line: &[u8], tz: i64) {
        if !has(line, b"\"usage\"") {
            return;
        }
        let Ok(row) = serde_json::from_slice::<Value>(line) else { return };
        let message = &row["message"];
        let (Some(id), Some(usage)) = (message["id"].as_str(), message["usage"].as_object()) else { return };
        let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        let tokens = [
            n("input_tokens"),
            n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
            n("output_tokens"),
        ];
        let day = row["timestamp"].as_str().and_then(|t| local_day(t, tz)).unwrap_or(0);
        self.messages.insert(id.to_string(), (day, tokens));
    }

    fn codex_line(&mut self, line: &[u8], tz: i64) {
        if !has(line, b"\"token_count\"") {
            return;
        }
        let Ok(row) = serde_json::from_slice::<Value>(line) else { return };
        let payload = &row["payload"];
        if payload["type"] != "token_count" {
            return;
        }
        if let Some(limits) = codex_limits(&payload["rate_limits"]) {
            self.limits = Some(limits);
        }
        let Some(usage) = payload["info"]["total_token_usage"].as_object() else { return };
        let n = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        // У Codex вход уже включает кэш.
        let cache = n("cached_input_tokens");
        let total = [n("input_tokens").saturating_sub(cache), cache, n("output_tokens")];
        let (now, was) = (sum(total), sum(self.total));
        // Итог нарастающий: дню достаётся прирост. Итог уменьшился — счёт начался заново.
        let grew = if now >= was { now - was } else { now };
        let day = row["timestamp"].as_str().and_then(|t| local_day(t, tz)).unwrap_or(0);
        *self.days.entry(day).or_default() += grew;
        self.total = total;
    }

    fn report(&self, codex: bool) -> Value {
        let (total, days) = if codex {
            (self.total, self.days.clone())
        } else {
            let mut total = [0u64; 3];
            let mut days: HashMap<i64, u64> = HashMap::new();
            for (day, tokens) in self.messages.values() {
                for (sum, n) in total.iter_mut().zip(tokens) {
                    *sum += n;
                }
                *days.entry(*day).or_default() += sum(*tokens);
            }
            (total, days)
        };
        let mut by_day: Vec<(i64, u64)> = days.into_iter().filter(|(_, n)| *n > 0).collect();
        by_day.sort();
        let days: Map<String, Value> = by_day.into_iter().map(|(day, n)| (day.to_string(), n.into())).collect();
        json!({ "input": total[0], "cache": total[1], "output": total[2], "days": days, "limits": self.limits })
    }
}

fn sum(tokens: Tokens) -> u64 {
    tokens.iter().sum()
}

fn has(line: &[u8], needle: &[u8]) -> bool {
    line.windows(needle.len()).any(|w| w == needle)
}

/// Лимиты подписки Codex в общем виде: окна с долей расхода. None — подписки нет (работа по API).
fn codex_limits(raw: &Value) -> Option<Value> {
    let windows: Vec<Value> = ["primary", "secondary"]
        .iter()
        .filter_map(|key| {
            let w = raw.get(key)?;
            Some(json!({ "minutes": w["window_minutes"].as_u64()?, "used": w["used_percent"].as_f64()?, "resets": w["resets_at"] }))
        })
        .collect();
    (!windows.is_empty()).then(|| json!({ "windows": windows, "plan": raw["plan_type"] }))
}

/// Лимиты подписки Claude Code из данных его строки состояния. None — подписки нет.
pub fn claude_limits(raw: &Value) -> Option<Value> {
    let windows: Vec<Value> = [("five_hour", 300), ("seven_day", 10080)]
        .iter()
        .filter_map(|(key, minutes)| {
            let w = raw.get(key)?;
            Some(json!({ "minutes": minutes, "used": w["used_percentage"].as_f64()?, "resets": w["resets_at"] }))
        })
        .collect();
    (!windows.is_empty()).then(|| json!({ "windows": windows }))
}

/// «5ч 42% · 7д 18%»: то, что видно в строке состояния Claude Code.
pub fn limits_text(limits: &Value) -> String {
    let parts: Vec<String> = limits["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            let minutes = w["minutes"].as_u64().unwrap_or(0);
            let span = if minutes >= 1440 { format!("{}д", minutes / 1440) } else { format!("{}ч", minutes / 60) };
            format!("{span} {:.0}%", w["used"].as_f64().unwrap_or(0.0))
        })
        .collect();
    parts.join(" · ")
}

/// Номер дня от 1970-01-01 для отметки вида 2026-11-27T15:04:05Z, сдвинутой на tz минут.
fn local_day(stamp: &str, tz: i64) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| stamp.get(range)?.parse::<i64>().ok();
    let (y, m, d, h, min) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?);
    // Дни от эпохи по гражданской дате (алгоритм Говарда Хиннанта).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    Some((days * 1440 + h * 60 + min + tz).div_euclid(1440))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct Tmp(PathBuf);

    impl Tmp {
        fn new(name: &str) -> Tmp {
            let dir = std::env::temp_dir().join(format!("bybai-usage-{}-{name}", std::process::id()));
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

    fn append(file: &Path, text: &str) {
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::OpenOptions::new().create(true).append(true).open(file).unwrap().write_all(text.as_bytes()).unwrap();
    }

    fn claude_row(id: &str, stamp: &str, input: u64, made: u64, read: u64, output: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{stamp}","message":{{"id":"{id}","usage":{{"input_tokens":{input},"cache_creation_input_tokens":{made},"cache_read_input_tokens":{read},"output_tokens":{output}}}}}}}"#
        ) + "\n"
    }

    #[test]
    fn day_follows_the_local_clock() {
        assert_eq!(local_day("1970-01-01T00:00:00Z", 0), Some(0));
        assert_eq!(local_day("2026-11-27T15:04:05.123Z", 0), Some(20784));
        // 23:30 UTC — уже следующий день в UTC+2 и ещё тот же в UTC−5
        assert_eq!(local_day("2026-11-27T23:30:00Z", 120), Some(20785));
        assert_eq!(local_day("2026-11-27T03:00:00Z", -300), Some(20783));
        assert_eq!(local_day("2024-02-29T12:00:00Z", 0), Some(19782));
        assert_eq!(local_day("вчера", 0), None);
    }

    #[test]
    fn claude_counts_each_message_once() {
        let home = Tmp::new("claude");
        let file = home.0.join(".claude").join("projects").join("p").join("s.jsonl");
        // одно сообщение двумя строками: в счёт идёт последняя
        append(&file, &claude_row("m1", "2026-11-27T10:00:00Z", 10, 100, 1000, 5));
        append(&file, &claude_row("m1", "2026-11-27T10:00:01Z", 10, 100, 1000, 40));
        append(&file, "{\"type\":\"user\",\"message\":{\"content\":\"текст про usage\"}}\n");
        append(&file, &claude_row("m2", "2026-11-28T09:00:00Z", 3, 0, 500, 7));
        let mut scans = Scans::default();
        let path = file.to_str().unwrap();
        let got = scans.usage(&home.0, "claude", "s", Some(path), 0).unwrap();
        assert_eq!(got, json!({ "input": 13, "cache": 1600, "output": 47, "days": { "20784": 1150, "20785": 510 }, "limits": null }));

        // недописанная строка ждёт следующего чтения; повторный вызов ничего не удваивает
        let row = claude_row("m3", "2026-11-28T09:05:00Z", 1, 0, 0, 1);
        append(&file, &row[..row.len() - 10]);
        assert_eq!(scans.usage(&home.0, "claude", "s", Some(path), 0).unwrap()["output"], 47);
        append(&file, &row[row.len() - 10..]);
        assert_eq!(scans.usage(&home.0, "claude", "s", Some(path), 0).unwrap()["output"], 48);

        // журнал вне каталога Claude Code не читаем
        let stray = home.0.join("other.jsonl");
        append(&stray, &claude_row("m1", "2026-11-27T10:00:00Z", 1, 1, 1, 1));
        assert_eq!(scans.usage(&home.0, "claude", "s", Some(stray.to_str().unwrap()), 0), None);
        assert_eq!(scans.usage(&home.0, "claude", "s", None, 0), None);
    }

    #[test]
    fn codex_takes_the_running_total() {
        let home = Tmp::new("codex");
        let sid = "019a-abc";
        let file = home.0.join(".codex").join("sessions").join("2026").join("11").join("27").join(format!("rollout-2026-11-27T14-48-30-{sid}.jsonl"));
        let row = |stamp: &str, input: u64, cached: u64, output: u64, used: f64| {
            format!(
                r#"{{"timestamp":"{stamp}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"output_tokens":{output},"total_tokens":{}}}}},"rate_limits":{{"primary":{{"used_percent":{used},"window_minutes":300,"resets_at":1795800000}},"secondary":{{"used_percent":30.5,"window_minutes":10080,"resets_at":1796000000}},"plan_type":"plus"}}}}}}"#,
                input + output
            ) + "\n"
        };
        append(&file, &row("2026-11-27T12:00:00Z", 1000, 800, 50, 10.0));
        append(&file, &row("2026-11-27T23:30:00Z", 3000, 2500, 120, 12.0));
        // событие без итога приносит только лимиты
        append(&file, "{\"timestamp\":\"2026-11-27T23:31:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":null,\"rate_limits\":{\"primary\":{\"used_percent\":13.0,\"window_minutes\":300,\"resets_at\":1795800000}}}}\n");
        let mut scans = Scans::default();
        let got = scans.usage(&home.0, "codex", sid, None, 120).unwrap();
        assert_eq!(got["input"], 500);
        assert_eq!(got["cache"], 2500);
        assert_eq!(got["output"], 120);
        // в UTC+2 второе событие пришлось уже на следующий день
        assert_eq!(got["days"], json!({ "20784": 1050, "20785": 2070 }));
        assert_eq!(got["limits"], json!({ "windows": [{ "minutes": 300, "used": 13.0, "resets": 1795800000 }], "plan": null }));
        assert_eq!(limits_text(&got["limits"]), "5ч 13%");

        assert_eq!(scans.usage(&home.0, "codex", "нет-такой", None, 0), None);
        assert_eq!(scans.usage(&home.0, "codex", "../x", None, 0), None);
    }

    #[test]
    fn claude_limits_come_from_the_status_line() {
        let raw = json!({ "five_hour": { "used_percentage": 41.6, "resets_at": 1795800000 }, "seven_day": { "used_percentage": 18.2, "resets_at": 1796000000 } });
        let limits = claude_limits(&raw).unwrap();
        assert_eq!(limits_text(&limits), "5ч 42% · 7д 18%");
        // работа по API: лимитов подписки нет
        assert_eq!(claude_limits(&Value::Null), None);
        assert_eq!(claude_limits(&json!({})), None);
    }
}
