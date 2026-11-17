/**
 * Exceptions: `withExceptions()` settings, the handler, the developer error page with its
 * "Copy as Markdown for AI" twin, and the `report()` helper.
 *
 * @example
 * import { ExceptionsConfig, report } from '@strutvane/framework'
 *
 * @module
 */
export {
  appRelative,
  type CodeFrame,
  codeFrame,
  FRAMEWORK_SOURCE,
  isAppFrame,
  parseStack,
  type SplitFrames,
  type StackFrame,
  splitFrames,
  stackFrames,
} from './code-frame.ts'
export {
  type DebugMember,
  type DebugPage,
  debugMember,
  debugPageCsp,
  escapeHtml,
  renderDebugPage,
  renderMarkdown,
} from './debug-page.ts'
export {
  buildReport,
  type ErrorReport,
  isSensitive,
  MAX_CODE_FRAMES,
  MAX_FRAMES,
  MAX_MESSAGE,
  type ReportFrame,
  redactHeaders,
  redactPath,
  redactText,
} from './error-report.ts'
export {
  type ErrorClass,
  ExceptionHandler,
  type ExceptionHandlerOptions,
  type ExceptionRenderCallback,
  type ExceptionReporter,
  ExceptionsConfig,
  type ThrottleOptions,
} from './handler.ts'
export { ExceptionHandlerToken, report } from './report.ts'
