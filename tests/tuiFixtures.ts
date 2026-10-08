import type { SessionRow } from '@pocketshell/core';
import { initialState, reduce, type Action, type TuiState } from '../src/tui/state.js';

export const NOW = 1_800_000_000;

export function row(name: string, extra: Partial<SessionRow> = {}): SessionRow {
  const [ws, tag] = name.split(':');
  return {
    name,
    id: `id-${name}`,
    workspace: `/home/u/git/${ws}`,
    tag: tag ?? name,
    engine: null,
    profile: null,
    agent: 'claude',
    agentState: 'idle',
    agentStateSource: 'heuristic',
    attached: false,
    createdEpoch: NOW - 3600,
    activityEpoch: NOW - 30,
    phase: 'running',
    ...extra,
  };
}

export const SESSIONS: SessionRow[] = [
  row('zeta:main', { agentState: 'working', agent: 'codex', activityEpoch: NOW - 2 }),
  row('alpha:review', { agentState: 'waiting', activityEpoch: NOW - 125 }),
  row('alpha:fix-login', { agentState: 'working', attached: true, activityEpoch: NOW - 5 }),
  row('beta:docs', { agentState: 'idle', agent: null, engine: 'grok', activityEpoch: NOW - 7200 }),
  row('loose', { workspace: null, tag: 'loose', agent: null, agentState: null, phase: 'exiting', activityEpoch: null }),
];

export function base(width = 80, height = 24): TuiState {
  return initialState({ hostName: 'local', hostMode: 'local', width, height, now: NOW, home: '/home/u' });
}

export function apply(state: TuiState, ...actions: Action[]): TuiState {
  return actions.reduce((s, action) => reduce(s, action).state, state);
}

export function loaded(sessions: SessionRow[] = SESSIONS, width = 80, height = 24): TuiState {
  return apply(base(width, height), {
    type: 'refreshDone',
    generation: 0,
    sessions,
    errors: [],
    workspaces: null,
    now: NOW,
  });
}
