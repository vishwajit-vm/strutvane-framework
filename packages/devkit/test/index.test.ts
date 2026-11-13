/** The public entry point exports exactly the documented runtime API. */
import { expect, test } from 'vitest'
import * as devkit from '../src/index.ts'

test('runtime exports', () => {
  expect(Object.keys(devkit).sort()).toEqual(
    [
      'DevkitError',
      'GeneratorInputError',
      'LOCK_PATH',
      'STATE_DIR',
      'TransactionAbortedError',
      'applyUpgrade',
      'basePathOf',
      'checkIdempotent',
      'commitTransaction',
      'createBiomeCliFormatter',
      'createConfigPatcher',
      'createDepsEditor',
      'createEnvEditor',
      'createStagedFs',
      'defineGenerator',
      'defineInstaller',
      'describeError',
      'detectIndent',
      'envKeys',
      'formatEnvValue',
      'formatHeader',
      'fromLines',
      'hasConflictMarkers',
      'hasInterruptedTransaction',
      'isSecretEnvFile',
      'planRecovery',
      'REDACTED',
      'redactEnvLine',
      'lineKey',
      'looksSecret',
      'matchLineEndings',
      'mergeShapes',
      'mergeThreeWay',
      'mergeTwoWay',
      'nodeIo',
      'normaliseRelativePath',
      'parseHeader',
      'planUpgrade',
      'providerLocalName',
      'readBase',
      'readLock',
      'recordEjection',
      'recoverTransactions',
      'renderUpgradePreview',
      'resolveInsideProject',
      'runGenerator',
      'runInstaller',
      'sectionHeader',
      'serializeLock',
      'sha256',
      'shapeOf',
      'stagingDir',
      'toLines',
      'toProjectPath',
      'tryFormat',
      'validateInput',
    ].sort(),
  )
})

test('errors carry stable codes and causes', () => {
  const cause = new Error('root')
  const error = new devkit.DevkitError('FILE_EXISTS', 'exists', { cause })
  expect(error).toMatchObject({ name: 'DevkitError', code: 'FILE_EXISTS', cause })
  expect(new devkit.DevkitError('FILE_EXISTS', 'x').cause).toBeUndefined()
  expect(devkit.describeError(error)).toBe('exists')
  expect(devkit.describeError('plain')).toBe('plain')
  const aborted = new devkit.TransactionAbortedError('nope', false)
  expect(aborted).toMatchObject({ code: 'TRANSACTION_ABORTED', rolledBack: false })
  expect(aborted).toBeInstanceOf(devkit.DevkitError)
})
