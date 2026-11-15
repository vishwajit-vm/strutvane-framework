/**
 * Help text for `sv help`, `sv help <command>`, `sv <command> --help` and namespace listings.
 *
 * Help is generated from the same declarations the parser uses, so it can never drift from what
 * the CLI actually accepts.
 *
 * @module
 */

import { CLI_PACKAGE } from '../version.ts'
import type { AnyCommand, FlagDefinition } from './command.ts'
import { GLOBAL_FLAGS } from './globals.ts'
import { formatTable, type Style } from './output.ts'
import { usageLine } from './parse.ts'

/** Where the online command reference lives. */
export const DOCS_URL =
  'https://github.com/vishwajit-vm/strutvane/blob/main/docs/09-cli-reference.md'

function flagLabel(name: string, def: FlagDefinition): string {
  const short = def.short === undefined ? '' : `-${def.short}, `
  const value = def.type === 'string' ? ` ${def.valueName ?? '<value>'}` : ''
  return `${short}--${name}${value}`
}

function flagDescription(def: FlagDefinition): string {
  const extras: string[] = []
  if (def.choices !== undefined) extras.push(`one of: ${def.choices.join(', ')}`)
  if (def.default !== undefined) extras.push(`default: ${String(def.default)}`)
  const base = def.description ?? ''
  return extras.length === 0 ? base : `${base} (${extras.join('; ')})`.trim()
}

function indent(lines: readonly string[]): string[] {
  return lines.map((l) => (l === '' ? '' : `  ${l}`))
}

/** A summary of one command for listings and `sv help --json`. */
export interface CommandSummary {
  readonly name: string
  readonly description: string
  readonly source: string
}

/** Summaries of every visible command, sorted by name. */
export function summarize(
  commands: readonly AnyCommand[],
  sources: ReadonlyMap<string, string> = new Map(),
): CommandSummary[] {
  return commands
    .filter((c) => c.hidden !== true)
    .map((c) => ({
      name: c.name,
      description: c.description,
      source: sources.get(c.name) ?? CLI_PACKAGE,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** `sv help`: every command, grouped by namespace. */
export function renderGlobalHelp(
  commands: readonly AnyCommand[],
  version: string,
  style: Style,
): string {
  const visible = summarize(commands)
  const groups = new Map<string, CommandSummary[]>()
  for (const c of visible) {
    const group = c.name.includes(':') ? (c.name.split(':')[0] ?? '') : ''
    groups.set(group, [...(groups.get(group) ?? []), c])
  }
  const lines = [
    `${style.bold('strutvane')} ${version}: the Strutvane command line`,
    '',
    `${style.bold('Usage:')} sv <command> [arguments] [flags]`,
    '',
  ]
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : 1))
  for (const key of keys) {
    lines.push(style.bold(key === '' ? 'Commands:' : `${key}:`))
    const rows = (groups.get(key) ?? []).map((c) => [c.name, c.description])
    lines.push(...indent(formatTable(['', ''], rows).slice(1)), '')
  }
  lines.push(style.bold('Global flags:'))
  const flagRows = Object.entries(GLOBAL_FLAGS).map(([name, def]) => [
    flagLabel(name, def),
    def.description,
  ])
  lines.push(...indent(formatTable(['', ''], flagRows).slice(1)), '')
  lines.push(
    'Run `sv help <command>` for details. Colon names also work with spaces: `sv make model`.',
  )
  lines.push(`Reference: ${DOCS_URL}`)
  return `${lines.join('\n')}\n`
}

/** `sv help <command>` / `sv <command> --help`. */
export function renderCommandHelp(command: AnyCommand, style: Style, source?: string): string {
  const lines = [style.bold(command.name), '', command.description]
  if (command.details !== undefined) lines.push('', ...command.details.trim().split('\n'))
  lines.push('', `${style.bold('Usage:')} ${usageLine(command)}`)
  if (command.aliases !== undefined && command.aliases.length > 0) {
    lines.push(`${style.bold('Aliases:')} ${command.aliases.join(', ')}`)
  }
  const args = Object.entries(
    (command.args ?? {}) as Record<string, { description?: string; required?: boolean }>,
  )
  if (args.length > 0) {
    lines.push('', style.bold('Arguments:'))
    const rows = args.map(([name, def]) => [
      name,
      `${def.description ?? ''}${def.required === true ? '' : ' (optional)'}`.trim(),
    ])
    lines.push(...indent(formatTable(['', ''], rows).slice(1)))
  }
  const flags = Object.entries((command.flags ?? {}) as Record<string, FlagDefinition>)
  if (flags.length > 0) {
    lines.push('', style.bold('Flags:'))
    const rows = flags.map(([name, def]) => [flagLabel(name, def), flagDescription(def)])
    lines.push(...indent(formatTable(['', ''], rows).slice(1)))
  }
  lines.push(
    '',
    style.dim(
      'Global flags: --json --dry-run --diff --yes --force --cwd <path> --no-color (sv help)',
    ),
  )
  if (command.examples !== undefined && command.examples.length > 0) {
    lines.push('', style.bold('Examples:'), ...indent(command.examples))
  }
  if (source !== undefined) lines.push('', style.dim(`Provided by ${source}`))
  lines.push('', `Reference: ${DOCS_URL}`)
  return `${lines.join('\n')}\n`
}

/** `sv make`: the commands in one namespace. */
export function renderGroupHelp(
  group: string,
  commands: readonly AnyCommand[],
  style: Style,
): string {
  const rows = summarize(commands).map((c) => [c.name, c.description])
  return `${[
    `${style.bold(`${group}:`)} available commands`,
    '',
    ...indent(formatTable(['', ''], rows).slice(1)),
    '',
    `Run \`sv help ${group}:<command>\` for details.`,
  ].join('\n')}\n`
}
