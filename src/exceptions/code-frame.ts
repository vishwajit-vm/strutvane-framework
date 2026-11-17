/**
 * Read an error's stack and show the code around the line that threw, like Laravel's Ignition.
 *
 * **Only the app's own files are quoted.** A frame is an *app frame* when its file is inside the
 * app's base path, outside `node_modules`, outside the framework's own source, and has a source
 * extension. Everything else (Node internals, dependencies, the framework) is counted, never
 * shown, so the page never prints framework internals and never reads an arbitrary file named in
 * a crafted stack (`/srv/app/.env:1:1` is not a source file).
 *
 * **The message is not part of the stack.** V8 starts `error.stack` with `Name: message`, and a
 * message can contain newlines that look exactly like frames (`\n    at x (/srv/app/.env:1:1)`).
 * {@link stackFrames} drops that header before parsing, so a message can never plant a frame.
 *
 * @module
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * One parsed stack frame.
 *
 * @example
 * const frame: StackFrame = { file: '/srv/blog/app/http/controllers/post.controller.ts', line: 12, column: 5, functionName: 'PostController.show' }
 */
export interface StackFrame {
  /** Absolute path (or the raw location when it isn't a file). */
  readonly file: string
  readonly line: number
  readonly column: number
  readonly functionName: string
}

/**
 * A few lines of source around a frame. `highlight` is the line that threw.
 *
 * @example
 * frame.lines.find((line) => line.number === frame.highlight)?.text // 'throw new Error(…)'
 */
export interface CodeFrame {
  /** Path relative to the app root, with forward slashes. */
  readonly file: string
  readonly highlight: number
  readonly lines: readonly { readonly number: number; readonly text: string }[]
}

/**
 * The stack split into what the page may show and what it only counts.
 *
 * @example
 * const { app, hidden } = splitFrames(stackFrames(error), basePath)
 */
export interface SplitFrames {
  /** Frames in the app's own source files, outermost last (stack order). */
  readonly app: readonly StackFrame[]
  /** How many frames were hidden (Node, dependencies, the framework). */
  readonly hidden: number
}

const FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
])
/** Source files bigger than this are not quoted (a minified bundle is no help on the page). */
const MAX_SOURCE_BYTES = 1024 * 1024
/** A quoted line longer than this is cut (minified code). */
const MAX_LINE = 240
/**
 * The framework's own `src/` (or `dist/` once built): its files are never app frames.
 *
 * @example
 * isAppFrame(frame, basePath, FRAMEWORK_SOURCE)
 */
export const FRAMEWORK_SOURCE: string = dirname(import.meta.dirname)

/**
 * Parse a V8 stack trace into frames, skipping `node:` internals. Pass only the frame lines: use
 * {@link stackFrames} for an error, so its message can't plant frames.
 *
 * @example
 * parseStack('Error: x\n    at show (/srv/blog/app/x.ts:3:9)')[0]?.line // 3
 */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = []
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line)
    if (match === null) continue
    const [, functionName = '<anonymous>', location = '', lineNumber = '0', column = '0'] = match
    if (location.startsWith('node:')) continue
    frames.push({
      file: toPath(location),
      line: Number(lineNumber),
      column: Number(column),
      functionName,
    })
  }
  return frames
}

/**
 * An error's frames, parsed from its stack *after* the `Name: message` header, so a message
 * containing fake `at …` lines adds nothing.
 *
 * @example
 * stackFrames(new Error('boom'))[0]?.functionName
 */
export function stackFrames(error: unknown): StackFrame[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return []
  let stack = error.stack
  const header = `${error.name}: ${error.message}`
  if (stack.startsWith(header)) stack = stack.slice(header.length)
  else if (error.message !== '') {
    // A stack without the usual header (rewritten by a tool): drop every line of the message.
    const at = stack.indexOf(error.message)
    if (at !== -1) stack = stack.slice(at + error.message.length)
  }
  return parseStack(stack)
}

function toPath(location: string): string {
  if (!location.startsWith('file://')) return location
  // Vitest and Node may add a query string (`?v=123`) to module URLs; it is not part of the path.
  try {
    return fileURLToPath(location.replace(/[?#].*$/, ''))
  } catch {
    return location
  }
}

/**
 * Whether a frame points into the app's own source: inside `basePath`, not in `node_modules`, not
 * in the framework, and a source file by its extension.
 *
 * @example
 * isAppFrame({ file: '/srv/blog/app/x.ts', line: 1, column: 1, functionName: 'x' }, '/srv/blog') // true
 */
export function isAppFrame(
  frame: StackFrame,
  basePath: string,
  frameworkRoot: string = FRAMEWORK_SOURCE,
): boolean {
  if (!isInside(frame.file, basePath)) return false
  if (/[\\/]node_modules[\\/]/.test(frame.file)) return false
  if (isInside(frame.file, frameworkRoot)) return false
  return SOURCE_EXTENSIONS.has(extname(frame.file).toLowerCase())
}

/**
 * Split frames into app frames (shown) and the rest (counted).
 *
 * @example
 * splitFrames(stackFrames(error), '/srv/blog').hidden // 14
 */
export function splitFrames(
  frames: readonly StackFrame[],
  basePath: string,
  frameworkRoot: string = FRAMEWORK_SOURCE,
): SplitFrames {
  const app = frames.filter((frame) => isAppFrame(frame, basePath, frameworkRoot))
  return { app, hidden: frames.length - app.length }
}

/**
 * Lines around a frame, read from disk. `undefined` when the file is not app source, is missing,
 * or is too big to be useful.
 *
 * @example
 * codeFrame(frame, '/srv/blog', 5)?.highlight // 12
 */
export function codeFrame(
  frame: StackFrame,
  basePath: string,
  context = 5,
  frameworkRoot: string = FRAMEWORK_SOURCE,
): CodeFrame | undefined {
  if (!isAppFrame(frame, basePath, frameworkRoot)) return undefined
  const source = readSource(frame.file)
  if (source === undefined) return undefined
  const lines = source.split(/\r?\n/)
  if (frame.line < 1 || frame.line > lines.length) return undefined
  const first = Math.max(1, frame.line - context)
  const last = Math.min(lines.length, frame.line + context)
  const quoted: { number: number; text: string }[] = []
  for (let number = first; number <= last; number += 1) {
    const text = lines[number - 1] ?? ''
    quoted.push({ number, text: text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text })
  }
  return {
    file: relative(resolve(basePath), resolve(frame.file)).replace(/\\/g, '/'),
    highlight: frame.line,
    lines: quoted,
  }
}

/**
 * A path relative to the app root, with forward slashes (for the page and the Markdown).
 *
 * @example
 * appRelative('/srv/blog/app/x.ts', '/srv/blog') // 'app/x.ts'
 */
export function appRelative(file: string, basePath: string): string {
  return isInside(file, basePath)
    ? relative(resolve(basePath), resolve(file)).replace(/\\/g, '/')
    : file
}

function readSource(file: string): string | undefined {
  let descriptor: number | undefined
  try {
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_SOURCE_BYTES) return undefined
    descriptor = openSync(file, 'r')
    const buffer = Buffer.alloc(stats.size)
    const read = readSync(descriptor, buffer, 0, stats.size, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function isInside(file: string, basePath: string): boolean {
  if (!isAbsolute(file)) return false
  const path = relative(resolve(basePath), resolve(file))
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}
