/**
 * A project file that cannot be loaded (a syntax error, a top-level throw) and a boot that fails
 * or never finishes are the user's configuration, not a framework bug: the CLI must name the file
 * or the failing provider, say what to check, and exit with a non-zero code, instead of
 * "Unexpected error: Expression expected … report the bug".
 */
import { afterEach, describe, expect, it } from 'vitest'
import { toFailure } from '../../src/console/framework/errors.ts'
import { EXIT } from '../../src/console/framework/exit-codes.ts'
import { renderMessages } from '../../src/console/framework/run.ts'
import { ProviderError } from '../../src/core/index.ts'
import { BootTimeoutError } from '../../src/runtime/boot.ts'
import { loadProject, ProjectLoadError } from '../../src/runtime/project.ts'
import { makeProject, projectFiles } from './project-fixture.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function brokenProject(files: Record<string, string>): Promise<string> {
  const p = await makeProject(projectFiles(files))
  cleanups.push(p.cleanup)
  return p.root
}

describe('a project file that cannot be loaded', () => {
  it.each([
    ['config/app.ts', 'export default { name: "x", port: '],
    ['config/database.ts', 'throw new Error("DATABASE_URL is missing")\nexport default {}'],
    ['app/models/broken.model.ts', 'export default ('],
  ])('%s: ProjectLoadError naming the file, a config error in the CLI', async (file, content) => {
    const root = await brokenProject({ [file]: content })
    const error = await loadProject(root, { dotenv: false }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProjectLoadError)
    expect((error as ProjectLoadError).code).toBe('project_invalid')
    expect((error as Error).message).toContain(file)
    const failure = toFailure(error)
    expect(failure).toMatchObject({ code: 'project_invalid', exitCode: EXIT.VALIDATION })
    expect(failure.unexpected).toBe(false)
    expect(renderMessages(failure).message).toContain(file)
  })
})

describe('boot failures in the CLI', () => {
  it('a provider failing to boot (database down at startup) is boot_failed, not a bug report', () => {
    const failure = toFailure(
      new ProviderError('@strutvane/framework', 'boot', new Error('connect ECONNREFUSED')),
    )
    expect(failure).toMatchObject({
      code: 'boot_failed',
      exitCode: EXIT.FAILURE,
      unexpected: false,
    })
    const { message, hint } = renderMessages(failure)
    expect(message).toMatch(/@strutvane\/framework.*ECONNREFUSED/)
    expect(hint).toMatch(/running/)
  })

  it('a boot that never finishes is boot_timeout', () => {
    const failure = toFailure(new BootTimeoutError(30_000))
    expect(failure).toMatchObject({
      code: 'boot_timeout',
      exitCode: EXIT.FAILURE,
      unexpected: false,
    })
    expect(renderMessages(failure).hint).toBeDefined()
  })

  it('a provider failing during shutdown is still unexpected (that is a bug)', () => {
    expect(toFailure(new ProviderError('x', 'shutdown', new Error('boom'))).unexpected).toBe(true)
  })
})
