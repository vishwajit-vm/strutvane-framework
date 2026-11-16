/**
 * `@strutvane/framework/devkit`: the SDK behind `sv add`, `sv make:*` and `sv upgrade`.
 *
 * - **Installers** (`defineInstaller`, `runInstaller`): transactional, previewable, idempotency-checked
 *   package setup: config files, `.env` + `.env.example`, `package.json`, `strutvane.config.ts`.
 * - **Generators** (`defineGenerator`, `runGenerator`): typed inputs (Standard Schema), plain
 *   TypeScript templates, staged writes.
 * - **Upgrades** (`planUpgrade`, `applyUpgrade`): a normalising three-way merge that never loses a
 *   user's edit (ADR-0012).
 * - **Building blocks**: the staged file system, editors, safe paths and multi-file transactions.
 *
 * @packageDocumentation
 */
export {
  type ConfigPatcher,
  type ConfigPatcherFs,
  createConfigPatcher,
  providerLocalName,
} from './config-patcher.ts'
export {
  createDepsEditor,
  type DepsAddResult,
  type DepsEditor,
  type DepsEditorFs,
  detectIndent,
} from './deps-editor.ts'
export {
  createEnvEditor,
  type EnvAddResult,
  type EnvEditor,
  type EnvEditorFs,
  type EnvEditorOptions,
  envKeys,
  formatEnvValue,
  looksSecret,
  sectionHeader,
} from './env-editor.ts'
export {
  DevkitError,
  type DevkitErrorCode,
  describeError,
  GeneratorInputError,
  type InputIssue,
  TransactionAbortedError,
} from './errors.ts'
export {
  defineGenerator,
  type GeneratedFile,
  type GenerateResult,
  type Generator,
  type RunGeneratorOptions,
  runGenerator,
  validateInput,
} from './generator.ts'
export {
  checkIdempotent,
  type DevkitInstallContext,
  type DevkitInstaller,
  defineInstaller,
  type InstallResult,
  type LogMessage,
  type RunInstallerOptions,
  runInstaller,
} from './installer.ts'
export {
  type DevkitIo,
  nodeIo,
  type PathInfo,
  type PathKind,
  sha256,
  type WriteTextOptions,
} from './io.ts'
export {
  createBiomeCliFormatter,
  type FormatOutcome,
  type Formatter,
  tryFormat,
} from './merge/format.ts'
export { formatHeader, parseHeader, type TemplateHeader } from './merge/header.ts'
export {
  type BaseReadResult,
  basePathOf,
  LOCK_PATH,
  type LockEntry,
  type LockFile,
  type LockReadResult,
  readBase,
  readLock,
  serializeLock,
} from './merge/lock.ts'
export {
  type Conflict,
  type ConflictKind,
  hasConflictMarkers,
  type MergeLabels,
  type MergeOptions,
  type MergeResult,
  mergeThreeWay,
  mergeTwoWay,
} from './merge/merge.ts'
export {
  type ApplyUpgradeResult,
  applyUpgrade,
  type PlanAction,
  type PlanItem,
  type PlanUpgradeOptions,
  planUpgrade,
  recordEjection,
  renderUpgradePreview,
  type TemplateOutput,
  type UpgradePlan,
} from './merge/upgrade.ts'
export { normaliseRelativePath, resolveInsideProject, toProjectPath } from './paths.ts'
export { isSecretEnvFile, REDACTED, redactEnvLine } from './secret-files.ts'
export {
  createStagedFs,
  type DiffOptions,
  type FileChange,
  type StagedFs,
  type WriteOptions,
} from './staged-fs.ts'
export {
  type Eol,
  fromLines,
  lineKey,
  matchLineEndings,
  mergeShapes,
  shapeOf,
  type TextShape,
  toLines,
} from './text.ts'
export {
  commitTransaction,
  type FileOperation,
  hasInterruptedTransaction,
  planRecovery,
  type RecoveryPlan,
  type RecoveryStep,
  type RecoveryTransaction,
  recoverTransactions,
  STATE_DIR,
  stagingDir,
} from './transaction.ts'
