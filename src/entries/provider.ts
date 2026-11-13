/**
 * `@strutvane/framework/provider`: the zero-option provider registered in `strutvane.config.ts`.
 *
 * @module
 */
import type { Provider } from '@strutvane/core'
import { createDefaultFrameworkProvider } from '../runtime/default-provider.ts'

export { createDefaultFrameworkProvider } from '../runtime/default-provider.ts'

/** The framework provider: database from `config/database.ts`, models from `app/models`. */
const provider: Provider = createDefaultFrameworkProvider()
export default provider
