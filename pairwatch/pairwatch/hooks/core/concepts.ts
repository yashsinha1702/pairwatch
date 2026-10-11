// The knowledge base index: every concept card, by id.
import type { Concept } from '../../types'
import { AGENT_CONCEPTS } from './kb/agent.ts'
import { DEV_CONCEPTS } from './kb/dev.ts'
import { SHELL_CONCEPTS } from './kb/shell.ts'

export const CONCEPTS: Readonly<Record<string, Concept>> = Object.fromEntries(
  [...AGENT_CONCEPTS, ...SHELL_CONCEPTS, ...DEV_CONCEPTS].map(c => [c.id, c]),
)

export const getConcept = (id: string): Concept | undefined => CONCEPTS[id]
