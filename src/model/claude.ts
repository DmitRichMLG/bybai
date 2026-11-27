// Хуки Claude Code → общие события. Формат тела: code.claude.com/docs/en/hooks
import type { ActionKind, Envelope, Ev, FileChange, NormEvent, StartEv, StepStatus } from './types';
import { delta, diffLines, firstLine, isObj, lines, plural, rel, text } from './util';

const STATUS: Record<string, StepStatus | 'deleted'> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'done',
  deleted: 'deleted',
};

/** Служебные вызовы, которые не показываем как действия. */
const SILENT = new Set(['TaskUpdate', 'TaskList', 'TaskGet', 'EnterPlanMode', 'ToolSearch']);

export function normalizeClaude(env: Envelope): NormEvent[] {
  const b = env.body;
  if (!isObj(b) || typeof b.session_id !== 'string') return [];
  const cwd = typeof b.cwd === 'string' ? b.cwd : undefined;
  const out = (...evs: Ev[]): NormEvent[] =>
    evs.map((ev) => ({ ...ev, sid: b.session_id, source: 'claude', at: env.at, cwd }));

  const input = isObj(b.tool_input) ? b.tool_input : {};
  const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : `seq-${env.seq}`;
  const tool = typeof b.tool_name === 'string' ? b.tool_name : '';

  switch (b.hook_event_name) {
    case 'SessionStart':
      return out({ t: 'session' });

    case 'UserPromptSubmit':
      return out({ t: 'prompt', text: firstLine(b.prompt, 200) });

    case 'PreToolUse': {
      if (SILENT.has(tool) || tool === 'TaskCreate') return out();
      if (tool === 'TodoWrite') {
        const todos = Array.isArray(input.todos) ? input.todos.filter(isObj) : [];
        const steps = todos.map((t) => ({ text: firstLine(t.content, 200), status: (STATUS[t.status] ?? 'pending') as StepStatus }));
        return out({ t: 'plan', id, steps });
      }
      if (tool === 'ExitPlanMode') {
        return out({ t: 'plan-text', text: text(input.plan) }, { t: 'start', id, kind: 'plan', target: 'план на согласование' });
      }
      const ev = { ...start(id, tool, input, cwd), thread: typeof b.agent_id === 'string' ? b.agent_id : undefined };
      // Вопрос пользователю — это всегда ожидание человека.
      return tool === 'AskUserQuestion' ? out(ev, { t: 'waiting', text: ev.target }) : out(ev);
    }

    case 'PostToolUse': {
      if (SILENT.has(tool)) return out(...taskUpdate(tool, input));
      if (tool === 'TodoWrite') return out();   // план уже учтён при начале вызова
      if (tool === 'TaskCreate') {
        const task = isObj(b.tool_response) && isObj(b.tool_response.task) ? b.tool_response.task : {};
        const stepId = String(task.id ?? id);
        const subject = firstLine(input.subject ?? task.subject, 200);
        return out(
          { t: 'step', id: stepId, text: subject, status: 'pending' },
          { t: 'start', id, kind: 'plan', target: subject },
          { t: 'end', id, ok: true },
        );
      }
      const r = isObj(b.tool_response) ? b.tool_response : {};
      const found = typeof r.numFiles === 'number' ? plural(r.numFiles, 'файл', 'файла', 'файлов') : undefined;
      return out({ t: 'end', id, ok: true, note: found, created: r.type === 'create' || undefined });
    }

    case 'PostToolUseFailure': {
      const error = firstLine(b.error, 300);
      const code = /^Exit code (\d+)/.exec(error);
      return out({ t: 'end', id, ok: false, note: code ? `код ${code[1]}` : undefined, error: failText(b.error) });
    }

    case 'Notification':
      return b.notification_type === 'permission_prompt' ? out({ t: 'waiting', text: firstLine(b.message, 200) }) : out();

    case 'Stop':
      return out({ t: 'stop' });

    case 'SessionEnd':
      return out({ t: 'close' });

    default:
      return out();
  }
}

function taskUpdate(tool: string, input: Record<string, any>): Ev[] {
  if (tool !== 'TaskUpdate' || input.taskId == null) return [];
  const subject = input.subject == null ? undefined : firstLine(input.subject, 200);
  return [{ t: 'step', id: String(input.taskId), text: subject, status: STATUS[input.status] }];
}

function start(id: string, tool: string, input: Record<string, any>, cwd: string | undefined): StartEv {
  const act = (kind: ActionKind, target: string, note?: string, files?: FileChange[]): StartEv =>
    ({ t: 'start', id, kind, target, note: note || undefined, files });

  switch (tool) {
    case 'Read':
      return act('read', rel(input.file_path, cwd));
    case 'Edit':
    case 'NotebookEdit': {
      const path = rel(input.file_path ?? input.notebook_path, cwd);
      const { added, removed } = diffLines(input.old_string ?? '', input.new_string ?? input.new_source ?? '');
      return act('edit', path, delta(added, removed), [{ path, added, removed }]);
    }
    case 'Write': {
      const path = rel(input.file_path, cwd);
      const added = lines(input.content);
      return act('write', path, delta(added, 0), [{ path, added, removed: 0 }]);
    }
    case 'Bash':
    case 'PowerShell':
      return act('command', firstLine(input.command));
    case 'Grep':
    case 'Glob':
      return act('search', firstLine(input.pattern));
    case 'WebFetch':
      return act('web', host(input.url));
    case 'WebSearch':
      return act('web', firstLine(input.query));
    case 'Task':
    case 'Agent':
      return act('agent', firstLine(input.description ?? input.subagent_type));
    case 'AskUserQuestion': {
      const q = Array.isArray(input.questions) && isObj(input.questions[0]) ? input.questions[0].question : '';
      return act('ask', firstLine(q) || 'вопрос');
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return act('mcp', `${mcp[1]} · ${mcp[2]}`);
  return act('other', tool);
}

function host(url: unknown): string {
  try {
    return new URL(text(url)).host;
  } catch {
    return firstLine(url);
  }
}

/** Причина ошибки: у команд первая строка — «Exit code N», полезное идёт дальше. */
function failText(error: unknown): string {
  const rows = text(error).split('\n').map((s) => s.trim()).filter(Boolean);
  const useful = rows.find((s) => !/^Exit code \d+/.test(s)) ?? rows[0] ?? '';
  return useful.length > 300 ? useful.slice(0, 299) + '…' : useful;
}
