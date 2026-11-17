/**
 * Every ejected file starts with a one-line header naming the template that produced it:
 *
 *   // @strutvane-template framework/controller@1.2.0 (ejected: this file is yours to edit)
 *
 * The header is how `node strut upgrade` finds a file the user MOVED or RENAMED: the lock still points to
 * the old path, but the header travels with the content.
 *
 * @module
 */

/** A parsed template header. */
export interface TemplateHeader {
  /** Template id, e.g. `framework/controller`. */
  readonly template: string
  /** Template version, e.g. `1.2.0`. */
  readonly version: string
}

const TEMPLATE_ID = /^[a-z0-9][a-z0-9/-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const HEADER =
  /^﻿?\/\/ @strutvane-template ([a-z0-9][a-z0-9/-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/

/** The header line for a template output. Throws on an invalid id or version. */
export function formatHeader(header: TemplateHeader): string {
  if (!TEMPLATE_ID.test(header.template) || !VERSION.test(header.version)) {
    throw new Error(`invalid template header: ${header.template}@${header.version}`)
  }
  return `// @strutvane-template ${header.template}@${header.version} (ejected: this file is yours to edit)`
}

/** Parse the header from the first line of a file, if present. */
export function parseHeader(text: string): TemplateHeader | undefined {
  const match = HEADER.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return { template: match[1], version: match[2] }
}
