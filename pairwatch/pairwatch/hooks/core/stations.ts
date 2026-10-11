// Runtime facts about stations, shared by the stage, the text and the timeline.
import type { Station, StepStatus } from '../../types'

/** The rail, left to right. talk / done / idle sit at the "You" stop. */
export const RAIL: readonly { id: Station; label: string }[] = [
  { id: 'think', label: 'Think' },
  { id: 'plan', label: 'Plan' },
  { id: 'search', label: 'Search' },
  { id: 'read', label: 'Read' },
  { id: 'edit', label: 'Edit' },
  { id: 'run', label: 'Run' },
  { id: 'web', label: 'Web' },
  { id: 'delegate', label: 'Agents' },
  { id: 'tools', label: 'Tools' },
  { id: 'ask', label: 'You' },
]

/** Which rail stop a station sits at. */
export const RAIL_STOP: Record<Station, Station> = {
  think: 'think',
  plan: 'plan',
  search: 'search',
  read: 'read',
  edit: 'edit',
  run: 'run',
  web: 'web',
  delegate: 'delegate',
  tools: 'tools',
  ask: 'ask',
  talk: 'ask',
  done: 'ask',
  idle: 'ask',
}

/** Accent colour per station (the dark stage card; also the timeline pills). */
export const COLOR: Record<Station, string> = {
  think: '#a78bfa',
  plan: '#f472b6',
  search: '#38bdf8',
  read: '#60a5fa',
  edit: '#34d399',
  run: '#fbbf24',
  web: '#22d3ee',
  delegate: '#fb923c',
  tools: '#94a3b8',
  ask: '#f87171',
  talk: '#c084fc',
  done: '#4ade80',
  idle: '#64748b',
}

/** Header verb while the step runs, and once it is over. */
export const VERB: Record<Station, { running: string; over: string }> = {
  think: { running: 'THINKING', over: 'THOUGHT' },
  plan: { running: 'PLANNING', over: 'PLANNED' },
  search: { running: 'SEARCHING', over: 'SEARCHED' },
  read: { running: 'READING', over: 'READ' },
  edit: { running: 'EDITING', over: 'EDITED' },
  run: { running: 'RUNNING', over: 'RAN' },
  web: { running: 'BROWSING', over: 'BROWSED' },
  delegate: { running: 'DELEGATING', over: 'DELEGATED' },
  tools: { running: 'USING A TOOL', over: 'USED A TOOL' },
  ask: { running: 'WAITING FOR YOU', over: 'ASKED YOU' },
  talk: { running: 'ANSWERING', over: 'ANSWERED' },
  done: { running: 'DONE', over: 'DONE' },
  idle: { running: 'IDLE', over: 'IDLE' },
}

/** A one-glyph marker per station for text surfaces (terminal pane, status line). */
export const GLYPH: Record<Station, string> = {
  think: '💭',
  plan: '📋',
  search: '🔎',
  read: '📖',
  edit: '✏️',
  run: '▶️',
  web: '🌐',
  delegate: '🤝',
  tools: '🧩',
  ask: '🙋',
  talk: '💬',
  done: '✅',
  idle: '⏸️',
}

export const verbFor = (station: Station, status: StepStatus): string =>
  status === 'running' ? VERB[station].running : VERB[station].over
