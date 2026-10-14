import { posix, win32 } from 'node:path';
import type { SessionRow, SessionsListing } from '@pocketshell/core';

const string = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const ms = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

/** Mirror pocketshell.runtime.sessions' schema-3 snapshot adapter. */
export function directSessions(payload: unknown, now = Date.now()): SessionsListing {
  if (!Array.isArray(payload)) throw new Error('aplexer snapshot must be an array');
  const seen = new Set<string>();
  const sessions: SessionRow[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const workspace = string(r.workspace) ?? string(r.cwd);
    const tag = string(r.tag);
    const id = string(r.id)?.trim() || null;
    const windowsPath = workspace !== null && (/^[A-Za-z]:/.test(workspace) || workspace.startsWith('\\\\'));
    const path = windowsPath ? win32 : posix;
    const base = workspace === null ? ''
      : windowsPath && workspace.replace(/[\\/]+$/, '') === path.parse(workspace).root.replace(/[\\/]+$/, '')
        ? '' : path.basename(workspace);
    const name = base && tag?.trim() ? `${base}:${tag.trim()}` : tag?.trim() || id;
    const key = id ?? name;
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    if (!['starting', 'running', 'exiting'].includes(String(r.state).trim().toLowerCase())) continue;
    const phase = string(r.phase)?.trim().toLowerCase();
    const activity = ms(r.last_activity_ms);
    const reportedAt = ms(r.reported_state_at_ms);
    const reported = string(r.reported_state)?.trim().toLowerCase();
    let agentState: SessionRow['agentState'] = null;
    let agentStateSource: SessionRow['agentStateSource'] = null;
    if (phase !== 'exited' && phase !== 'failed') {
      if (phase !== 'starting' && reportedAt !== null && now - reportedAt <= 8000
        && (reported === 'idle' || reported === 'waiting' || reported === 'working')) {
        agentState = reported;
        agentStateSource = 'reported';
      } else {
        agentState = phase === 'starting' || activity === null || now - activity < 3000 ? 'working' : 'waiting';
        agentStateSource = 'heuristic';
      }
    }
    const count = r.attached_clients;
    const attached = typeof count === 'boolean' ? count
      : typeof count === 'number' && Number.isInteger(count) ? count > 0
      : typeof r.attached === 'boolean' ? r.attached
      : typeof r.attached === 'number' && Number.isInteger(r.attached) ? r.attached > 0 : false;
    const created = ms(r.created_at_ms);
    sessions.push({ name, id, workspace, tag, engine: r.engine === 'shell' ? null : string(r.engine)?.trim() || null,
      profile: string(r.profile), agent: string(r.agent)?.trim() || null, agentState, agentStateSource,
      attached, createdEpoch: created === null ? null : Math.floor(created / 1000),
      activityEpoch: activity === null ? null : Math.floor(activity / 1000), ...(phase ? { phase } : {}) });
  }
  return { sessions, errors: [] };
}
