// Хуки Codex CLI → общие события. Формат тела: developers.openai.com/codex/hooks
// Тело почти совпадает с Claude Code; отличаются имена инструментов и их аргументы.
import type { Envelope, Ev, FileChange, NormEvent, StartEv, StepStatus } from './types';
import { delta, firstLine, isObj, plural, rel, text } from './util';

const STATUS: Record<string, StepStatus> = { pending: 'pending', in_progress: 'running', completed: 'done' };

export function normalizeCodex(env: Envelope): NormEvent[] {
  const b = env.body;
  if (!isObj(b) || typeof b.session_id !== 'string') return [];
  const cwd = typeof b.cwd === 'string' ? b.cwd : undefined;
  const out = (...evs: Ev[]): NormEvent[] =>
    evs.map((ev) => ({ ...ev, sid: b.session_id, source: 'codex', at: env.at, cwd }));

  const input = isObj(b.tool_input) ? b.tool_input : {};
  const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : `seq-${env.seq}`;
  const tool = typeof b.tool_name === 'string' ? b.tool_name : '';

  switch (b.hook_event_name) {
    case 'SessionStart':
      return out({ t: 'session' });

    case 'UserPromptSubmit':
      return out({ t: 'prompt', text: firstLine(b.prompt, 200) });

    case 'PreToolUse': {
      if (tool === 'update_plan') {
        const plan = Array.isArray(input.plan) ? input.plan.filter(isObj) : [];
        return out({ t: 'plan', id, steps: plan.map((p) => ({ text: firstLine(p.step, 200), status: STATUS[p.status] ?? 'pending' })) });
      }
      return out({ ...start(id, tool, input, cwd), thread: typeof b.agent_id === 'string' ? b.agent_id : undefined });
    }

    case 'PostToolUse': {
      if (tool === 'update_plan') return out();
      // Хук приходит и для команды с ненулевым кодом: ищем код в её ответе.
      const code = /(?:exit(?:ed with)? code|exit_code)\D{0,4}(\d+)/i.exec(text(b.tool_response));
      if (tool === 'Bash' && code && code[1] !== '0') {
        return out({ t: 'end', id, ok: false, note: `код ${code[1]}`, error: lastLine(b.tool_response) });
      }
      return out({ t: 'end', id, ok: true });
    }

    case 'PermissionRequest':
      return out({ t: 'waiting', text: firstLine(input.command ?? tool, 200) });

    case 'Stop':
      return out({ t: 'stop' });

    case 'SessionEnd':
      return out({ t: 'close' });

    default:
      return out();
  }
}

function start(id: string, tool: string, input: Record<string, any>, cwd: string | undefined): StartEv {
  if (tool === 'Bash') return { t: 'start', id, kind: 'command', target: firstLine(input.command) };

  if (tool === 'apply_patch') {
    const files = patchFiles(text(input.command), cwd);
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    return {
      t: 'start', id,
      kind: files.length > 0 && files.every((f) => f.created) ? 'write' : 'edit',
      target: files.length === 1 ? files[0].path : plural(files.length, 'файл', 'файла', 'файлов'),
      note: delta(added, removed) || undefined,
      files,
    };
  }

  if (tool === 'view_image') return { t: 'start', id, kind: 'read', target: rel(input.path, cwd) };
  if (tool === 'spawn_agent') return { t: 'start', id, kind: 'agent', target: firstLine(input.prompt ?? input.message) || 'субагент' };

  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return { t: 'start', id, kind: 'mcp', target: `${mcp[1]} · ${mcp[2]}` };
  return { t: 'start', id, kind: 'other', target: tool };
}

/** Файлы и число строк из патча формата «*** Update File: путь». */
function patchFiles(patch: string, cwd: string | undefined): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | undefined;
  for (const line of patch.split('\n')) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line.trimEnd());
    if (head) {
      cur = { path: rel(head[2].trim(), cwd), added: 0, removed: 0, created: head[1] === 'Add' };
      files.push(cur);
    } else if (cur && !line.startsWith('***')) {
      if (line.startsWith('+')) cur.added++;
      else if (line.startsWith('-')) cur.removed++;
    }
  }
  return files;
}

function lastLine(v: unknown): string {
  const rows = text(v).split('\n').map((s) => s.trim()).filter(Boolean);
  const row = rows[rows.length - 1] ?? '';
  return row.length > 300 ? row.slice(0, 299) + '…' : row;
}
