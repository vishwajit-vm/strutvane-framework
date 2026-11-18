/**
 * Package message catalogs, registered at runtime: `app.addMessages(REDIS_MESSAGES_EN)` in a
 * provider's `register()` or `boot()` (RFC-0003 §2, integration map §3 `MessageCatalog`).
 *
 * **Why a live layer instead of rebuilding the catalog:** the core binds its `Messages` once, and
 * the container never lets a resolved service be rebound (holders would keep the old one). So the
 * app's `MessagesToken` is a thin wrapper whose package layer is read on every lookup: a catalog
 * added in `boot()` is visible to every holder, including ones resolved before it was added.
 *
 * Priority, highest first: field/resource overrides → the app's catalogs → the core's built-in
 * messages → **package catalogs** (this layer). A package fills keys nobody else defines (its own
 * `redis.unavailable`, …); it can never change a built-in or an app message. Among packages, a
 * later registration wins for the same key and locale.
 *
 * @module
 */
import type { MessageCatalog, MessageLookup, Messages } from '../core/messages/catalog.ts'
import { formatMessage } from '../core/messages/format.ts'
import { baseLanguage, canonicalLocale, localeChain } from '../core/messages/locale.ts'
import { BootError } from './boot-error.ts'

/**
 * The package layer: catalogs packages registered, merged per locale.
 *
 * @example
 * const layer = new PackageMessages()
 * layer.add([defineMessages('en', { 'redis.unavailable': 'Redis is not reachable.' })])
 * const messages = layer.over(createMessages())
 */
export class PackageMessages {
  readonly #byLocale = new Map<string, Record<string, string>>()

  /**
   * Register catalogs (from `defineMessages`). Anything else is refused with a `BootError`, so a
   * typo fails at boot instead of rendering keys instead of sentences.
   *
   * @example
   * layer.add([REDIS_MESSAGES_EN])
   */
  add(catalogs: readonly MessageCatalog[]): void {
    for (const catalog of catalogs) {
      const locale =
        typeof catalog === 'object' && catalog !== null && typeof catalog.locale === 'string'
          ? canonicalLocale(catalog.locale)
          : undefined
      const messages =
        typeof catalog === 'object' && catalog !== null ? catalog.messages : undefined
      if (
        locale === undefined ||
        typeof messages !== 'object' ||
        messages === null ||
        Object.values(messages).some((value) => typeof value !== 'string')
      )
        throw new BootError(
          'invalid_message_catalog',
          'app.addMessages() was given something that is not a message catalog.',
          "Build catalogs with defineMessages('en', { key: 'Text' }) from @strutvane/framework/core.",
        )
      this.#byLocale.set(locale, { ...this.#byLocale.get(locale), ...messages })
    }
  }

  /** Every locale a package registered. */
  locales(): readonly string[] {
    return [...this.#byLocale.keys()]
  }

  /**
   * The template for `key` in the locale chain of `locale`, or `undefined`.
   *
   * @example
   * layer.resolve('redis.unavailable', 'pt-BR') // falls back to pt, then en
   */
  resolve(key: string, locale: string | undefined): string | undefined {
    for (const candidate of localeChain(locale ?? 'en', 'en')) {
      const dictionary = this.#byLocale.get(candidate)
      if (dictionary !== undefined && Object.hasOwn(dictionary, key)) return dictionary[key]
    }
    return undefined
  }

  /**
   * `base` with this layer underneath it. Lookups read the layer live, so catalogs added later
   * are seen by everyone holding the result.
   *
   * @example
   * container.singleton(MessagesToken, () => layer.over(createMessages()))
   */
  over(base: Messages): Messages {
    const resolve = (key: string, lookup?: MessageLookup): string | undefined =>
      base.resolve(key, lookup) ?? this.resolve(key, lookup?.locale)
    return {
      resolve,
      has: (key, lookup) => resolve(key, lookup) !== undefined,
      format: (key, params, lookup) => {
        if (base.has(key, lookup)) return base.format(key, params, lookup)
        const template = this.resolve(key, lookup?.locale)
        if (template === undefined) return base.format(key, params, lookup)
        return formatMessage(template, params ?? {}, lookup?.locale ?? 'en').text
      },
      locales: () => [...new Set([...base.locales(), ...this.locales()])].sort(),
      missingKeys: (locale) => {
        const missing = new Set(base.missingKeys(locale))
        const canonical = canonicalLocale(locale) ?? locale
        const targets = new Set([canonical, baseLanguage(canonical)])
        for (const key of Object.keys(this.#byLocale.get('en') ?? {})) {
          const covered = [...targets].some((target) =>
            Object.hasOwn(this.#byLocale.get(target) ?? {}, key),
          )
          if (!covered) missing.add(key)
        }
        return [...missing].sort()
      },
    }
  }
}
