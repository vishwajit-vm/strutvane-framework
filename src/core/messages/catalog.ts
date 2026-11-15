/**
 * Message catalogs and the override chain (RFC-0003 §2), Laravel's `lang/` idea for TypeScript.
 *
 * Resolution order for a key (first match wins):
 * 1. for each locale in the chain (`pt-BR` → `pt` → fallback):
 * 2. for each layer, most specific first: **field → resource → app → package → built-in**,
 *    checking that layer's dictionary for the locale, then its language-neutral `*` dictionary.
 *
 * So a Portuguese app translation beats an English field override, but a field override written
 * for Portuguese (or for every language, `*`) beats the app catalog.
 *
 * @module
 */
import { BUILTIN_EN } from './builtin-en.ts'
import { formatMessage, type MessageParam } from './format.ts'
import { baseLanguage, canonicalLocale, localeChain } from './locale.ts'

/** Key → template. */
export type MessageDictionary = Readonly<Record<string, string>>

/** Messages for one locale. */
export interface MessageCatalog {
  readonly locale: string
  readonly messages: MessageDictionary
}

/** Locale → dictionary. The key `*` means "every locale" (language-neutral overrides). */
export type LocalizedMessages = Readonly<Record<string, MessageDictionary>>

/** Catalog layers registered on a {@link Messages} instance, lowest priority first. */
export type MessageLayer = 'builtin' | 'package' | 'app'

/** Per-call overrides from the model/resource definition. */
export interface MessageOverrides {
  readonly field?: LocalizedMessages
  readonly resource?: LocalizedMessages
}

/** Options for one lookup. */
export interface MessageLookup {
  /** Requested locale; defaults to the instance's fallback locale. */
  readonly locale?: string
  readonly overrides?: MessageOverrides
}

/** Resolves and formats messages. */
export interface Messages {
  /** The template for a key, or `undefined` if no layer defines it. */
  resolve(key: string, lookup?: MessageLookup): string | undefined
  /** Format a message. A missing key renders as the key itself (visible, never empty). */
  format(
    key: string,
    params?: Readonly<Record<string, MessageParam | undefined>>,
    lookup?: MessageLookup,
  ): string
  /** Whether any layer defines the key (in any locale of the chain). */
  has(key: string, lookup?: MessageLookup): boolean
  /** Every locale that has at least one catalog. */
  locales(): readonly string[]
  /**
   * Keys defined in the fallback locale but missing in `locale` (or its base language), sorted.
   * This powers `sv lang:check`.
   */
  missingKeys(locale: string): readonly string[]
}

/** Define a catalog. The locale is canonicalised and the dictionary frozen. */
export function defineMessages(locale: string, messages: Record<string, string>): MessageCatalog {
  const canonical = canonicalLocale(locale)
  if (!canonical)
    throw new RangeError(`defineMessages: "${locale}" is not a valid BCP 47 locale tag`)
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string')
      throw new TypeError(`defineMessages: message "${key}" must be a string`)
  }
  return Object.freeze({ locale: canonical, messages: Object.freeze({ ...messages }) })
}

/** Options for {@link createMessages}. */
export interface MessagesOptions {
  /** Locale used when nothing else matches. Default `en`. */
  readonly fallbackLocale?: string
  /** Package catalogs (registered by packages at boot). */
  readonly package?: readonly MessageCatalog[]
  /** The app's own catalogs (`lang/<locale>/*.ts`). */
  readonly app?: readonly MessageCatalog[]
  /** Include the built-in English messages. Default `true`. */
  readonly builtin?: boolean
}

type LayerMap = Map<string, Record<string, string>> // locale → merged dictionary

/**
 * `dict[key]` for own keys only. Keys and locales can come from outside (error codes, field
 * paths, override maps), and a plain-object lookup of `constructor` or `toString` would return an
 * inherited function instead of "no such message".
 */
function own<T>(dict: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return dict !== undefined && Object.hasOwn(dict, key) ? dict[key] : undefined
}

function toLayer(catalogs: readonly MessageCatalog[]): LayerMap {
  const layer: LayerMap = new Map()
  for (const c of catalogs) layer.set(c.locale, { ...layer.get(c.locale), ...c.messages })
  return layer
}

/** Create a message resolver from catalogs. */
export function createMessages(options: MessagesOptions = {}): Messages {
  const fallback = canonicalLocale(options.fallbackLocale ?? 'en') ?? 'en'
  // Highest priority first.
  const layers: LayerMap[] = [
    toLayer(options.app ?? []),
    toLayer(options.package ?? []),
    toLayer(options.builtin === false ? [] : [{ locale: 'en', messages: BUILTIN_EN }]),
  ]

  const resolve = (key: string, lookup: MessageLookup = {}): string | undefined => {
    const chain = localeChain(lookup.locale ?? fallback, fallback)
    const overrideLayers = [lookup.overrides?.field, lookup.overrides?.resource]
    for (const locale of chain) {
      for (const o of overrideLayers) {
        const hit = own(own(o, locale), key) ?? own(own(o, '*'), key)
        if (hit !== undefined) return hit
      }
      for (const layer of layers) {
        const hit = own(layer.get(locale), key)
        if (hit !== undefined) return hit
      }
    }
    return undefined
  }

  return {
    resolve,
    has: (key, lookup) => resolve(key, lookup) !== undefined,
    format(key, params = {}, lookup = {}) {
      const template = resolve(key, lookup)
      if (template === undefined) return key
      return formatMessage(template, params, lookup.locale ?? fallback).text
    },
    locales() {
      const all = new Set<string>()
      for (const layer of layers) for (const locale of layer.keys()) all.add(locale)
      return [...all].sort()
    },
    missingKeys(locale) {
      // A translation in the locale itself or in its base language counts (en-GB is covered by en).
      const canonical = canonicalLocale(locale) ?? locale
      const target = [...new Set([canonical, baseLanguage(canonical)])]
      const reference = new Set<string>()
      for (const layer of layers)
        for (const key of Object.keys(layer.get(fallback) ?? {})) reference.add(key)
      const missing: string[] = []
      for (const key of reference) {
        const found = target.some((l) =>
          layers.some((layer) => own(layer.get(l), key) !== undefined),
        )
        if (!found) missing.push(key)
      }
      return missing.sort()
    },
  }
}
