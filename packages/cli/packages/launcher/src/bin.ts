#!/usr/bin/env node
/**
 * `strutvane` executable: runs the launcher for this process.
 *
 * @module
 */
import { readFileSync } from 'node:fs'
import { nodeLaunchSpawner, runLauncher } from './launcher.ts'

function ownVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    const version = (manifest as { version?: unknown }).version
    return typeof version === 'string' ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

process.exitCode = await runLauncher(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  execPath: process.execPath,
  platform: process.platform,
  version: ownVersion(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  spawn: nodeLaunchSpawner,
})
