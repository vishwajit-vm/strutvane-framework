/**
 * Command lookup: canonical colon names, the space alias and unique prefixes (docs/09 §1.2).
 *
 * - `sv make:model Invoice` and `sv make model Invoice` are the same command: up to three leading
 *   words are joined with `:` and tried as a name, longest first.
 * - Unique prefixes are accepted per segment: `sv mi:st` → `migrate:status`. A prefix that fits
 *   several commands is an error listing them, never a guess.
 * - Exact matches always beat prefix matches, so adding a command can never change what an exact
 *   name means.
 *
 * @module
 */
import type { AnyCommand } from './command.ts'

/** How many leading words the space alias joins at most (`auth user create` → `auth:user:create`). */
const MAX_WORDS = 3

/** A set of commands, indexed by name and alias. */
export interface CommandTable {
  /** Every command, sorted by name. */
  readonly commands: readonly AnyCommand[]
  get(name: string): AnyCommand | undefined
}

/** Build a table. Later entries never replace earlier ones; callers resolve conflicts first. */
export function createCommandTable(commands: readonly AnyCommand[]): CommandTable {
  const byName = new Map<string, AnyCommand>()
  for (const command of commands) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      if (!byName.has(name)) byName.set(name, command)
    }
  }
  const sorted = [...new Set(byName.values())].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  return { commands: sorted, get: (name) => byName.get(name) }
}

/** The outcome of resolving the leading words of a command line. */
export type Resolution =
  | {
      readonly kind: 'found'
      readonly command: AnyCommand
      /** How many leading words named the command. */
      readonly consumed: number
    }
  | { readonly kind: 'ambiguous'; readonly input: string; readonly matches: readonly string[] }
  | {
      readonly kind: 'group'
      /** A namespace such as `make`, with the commands under it. */
      readonly group: string
      readonly commands: readonly AnyCommand[]
    }
  | { readonly kind: 'unknown'; readonly input: string; readonly suggestions: readonly string[] }

function allNames(table: CommandTable): string[] {
  return table.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])])
}

/** Does `input` (colon-separated) prefix-match `name` segment by segment? */
function prefixMatches(input: string, name: string): boolean {
  const a = input.split(':')
  const b = name.split(':')
  return a.length === b.length && a.every((segment, i) => (b[i] ?? '').startsWith(segment))
}

/** Resolve the leading words of `words` to a command. */
export function resolveCommand(table: CommandTable, words: readonly string[]): Resolution {
  const first = words[0] ?? ''
  const candidates: { text: string; consumed: number }[] = []
  for (let n = Math.min(MAX_WORDS, words.length); n >= 1; n--) {
    candidates.push({ text: words.slice(0, n).join(':'), consumed: n })
  }

  for (const { text, consumed } of candidates) {
    const command = table.get(text)
    if (command !== undefined) return { kind: 'found', command, consumed }
  }

  const names = allNames(table)
  for (const { text, consumed } of candidates) {
    const matches = [...new Set(names.filter((name) => prefixMatches(text, name)))]
    const commands = [...new Set(matches.map((m) => table.get(m)?.name ?? m))]
    if (commands.length === 1) {
      const command = table.get(matches[0] ?? '')
      if (command !== undefined) return { kind: 'found', command, consumed }
    }
    if (commands.length > 1) return { kind: 'ambiguous', input: text, matches: commands.sort() }
  }

  const grouped = table.commands.filter((c) => c.name.startsWith(`${first}:`) && c.hidden !== true)
  if (grouped.length > 0) return { kind: 'group', group: first, commands: grouped }

  return { kind: 'unknown', input: first, suggestions: suggest(first, names) }
}

/** Levenshtein edit distance (small inputs only: command names). */
export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] ?? 0
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + cost)
      diagonal = above
    }
  }
  return previous[b.length] ?? 0
}

/** Up to three "did you mean" names: close by edit distance, or containing the input. */
export function suggest(input: string, names: readonly string[]): string[] {
  if (input === '') return []
  const limit = Math.max(1, Math.floor(input.length / 3))
  return [...new Set(names)]
    .map((name) => ({ name, distance: editDistance(input, name) }))
    .filter(
      ({ name, distance }) => distance <= limit || (input.length >= 3 && name.includes(input)),
    )
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : 1))
    .slice(0, 3)
    .map(({ name }) => name)
}
