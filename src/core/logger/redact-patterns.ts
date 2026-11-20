/**
 * Secret patterns in free text: the one implementation shared by core's fallback logger, the
 * framework's logging pipeline (`src/logging`) and the developer error page, so every place that
 * writes text a person or a tool will read hides the same things.
 *
 * Pattern rules, each proven necessary by a tripwire test:
 * - JWTs
 * - Bearer/Basic/Token credentials
 * - credentials in URLs (`redis://:secret@host` too, and passwords containing `:` or `@`)
 * - webhook URLs whose path is the secret (Slack, Discord, Microsoft Teams)
 * - secret query parameters (`?token=…`, `&sig=…`, `#access_token=…`)
 * - `password=…`, `api_key: …` and similar in free text (connection strings, driver errors)
 * - well-known prefixed API keys (`sk_live_…`, `ghp_…`, `AKIA…`, `xoxb-…`, …)
 * - PEM private keys
 * - Luhn-valid card numbers
 *
 * Why it lives in core: core may import only the contracts, and the redaction rules must be the
 * same in core's fallback logger and in the full pipeline (RFC-0004 §6: "one matcher shared by
 * core's fallback logger and the logs pipeline"). Keys are matched by `serialize.ts`; this module
 * matches values.
 *
 * @module
 */
/** The replacement for a redacted value. */
export const REDACTED = '[REDACTED]'

/** The built-in pattern rules. Each one is proven necessary by a tripwire test. */
export type PatternRule =
  | 'jwt'
  | 'bearer'
  | 'urlCredentials'
  | 'webhook'
  | 'queryString'
  | 'keyValue'
  | 'apiKey'
  | 'privateKey'
  | 'pan'

/** Which built-in rules to skip, and which extra patterns to apply. */
export interface PatternOptions {
  /** Disable built-in rules (only meant for tests that prove each rule matters). */
  readonly disable: ReadonlySet<PatternRule>
  /** Extra patterns; every match is replaced by `[REDACTED]`. */
  readonly extraPatterns: readonly RegExp[]
}

/** No rule disabled, no extra pattern. */
export const DEFAULT_PATTERN_OPTIONS: PatternOptions = Object.freeze({
  disable: new Set<PatternRule>(),
  extraPatterns: [],
})

interface PatternDef {
  readonly rule: PatternRule
  readonly re: RegExp
  readonly replace: string | ((match: string, ...groups: string[]) => string)
}

const PATTERNS: readonly PatternDef[] = [
  // PEM private keys, complete or truncated at the end of the string.
  {
    rule: 'privateKey',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    replace: '[REDACTED:private-key]',
  },
  // JSON Web Tokens: three base64url segments, starting with the encoded '{"' header.
  {
    rule: 'jwt',
    re: /eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
    replace: '[REDACTED:jwt]',
  },
  // HTTP credentials in free text: "Bearer abc…", "Basic dXNlcjpwYXNz", "Token …".
  {
    rule: 'bearer',
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (m) => `${m.split(/\s+/)[0]} ${REDACTED}`,
  },
  // Webhook URLs whose path IS the secret (Slack, Discord, Microsoft Teams): anyone holding one
  // can post to the channel. The host and the kind of hook stay readable.
  {
    rule: 'webhook',
    re: /(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)\/|(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/webhooks\/|[a-z0-9-]+\.webhook\.office\.com\/|outlook\.office\.com\/webhook\/))[^\s"'<>`]+/gi,
    replace: (_m, prefix: string) => `${prefix}[REDACTED:webhook]`,
  },
  // Credentials inside URLs: scheme://user:password@host → scheme://user:[REDACTED]@host
  // - the user may be empty (`redis://:password@host`, the usual Redis form);
  // - the password may contain `:` and `@` (unencoded in hand-written connection strings), so it
  //   runs to the LAST `@` of the authority. `/`, `?` and `#` end the authority, as in every URL
  //   parser, so a URL with a port and an `@` later in its path or query keeps its host.
  // - Linear time: the match is the whole authority (no backtracking over the password), and the
  //   scheme is bounded and must start a word, so a long hostile string costs one pass.
  {
    rule: 'urlCredentials',
    re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#"'<>`]*/gi,
    replace: redactUserinfo,
  },
  // Secret query parameters inside any text: ?token=…, &X-Amz-Signature=…, #access_token=…
  // The name may carry a prefix (api_key, client_secret, refresh_token); only the value is hidden.
  {
    rule: 'queryString',
    re: /([?&#;](?:[a-z0-9]+[_.-])*(?:token|signature|sig|key|apikey|code|password|passwd|pwd|passphrase|secret|credentials?|otp|totp|mfa|pin|jwt|sid|session|sessionid|auth))=([^&#\s"'<>]+)/gi,
    replace: (m) => `${m.slice(0, m.indexOf('=') + 1)}${REDACTED}`,
  },
  // Secrets as `name=value` or `name: value` in free text: a libpq connection string
  // (`host=db password=…`), a driver error (`invalid api_key: …`), a config dump, JSON inside a
  // message. Only strong names (password, secret, token, api key, …) as the end of a word, so
  // prose such as "password reset" or "token count" stays readable. A quoted value keeps its
  // quotes; a value another rule already hid is left alone.
  {
    rule: 'keyValue',
    re: /(?<![A-Za-z0-9_.-])(["']?[a-z0-9_.-]*?(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?\s{0,3}[=:]\s{0,3})(?!\[REDACTED)("[^"]*"|'[^']*'|[^\s,;&"'<>)\]}]+)/gi,
    replace: (_m, head: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : ''
      return `${head}${quote}${REDACTED}${quote}`
    },
  },
  // Well-known API keys recognisable by their prefix (Strutvane, Stripe, GitHub, GitLab, npm,
  // Slack, AWS access key ids, Google API keys). Not glued to a preceding letter or digit.
  {
    rule: 'apiKey',
    re: /(?<![A-Za-z0-9])(?:(?:sv|sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9+/=]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|xox[abeoprs]-[A-Za-z0-9-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])|AIza[0-9A-Za-z_-]{35})/g,
    replace: '[REDACTED:api-key]',
  },
  // Card numbers: 13–19 digits (optional single spaces/dashes), not glued to other digits, Luhn-valid.
  {
    rule: 'pan',
    re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    replace: (m) => (luhnValid(m.replace(/[ -]/g, '')) ? '[REDACTED:pan]' : m),
  },
]

/**
 * Hide the password in a `scheme://authority` match: the userinfo runs to the authority's last
 * `@`, and the password is everything after the userinfo's first `:`. No `:` (a user only, or a
 * host and port) or no `@` leaves the text unchanged.
 */
function redactUserinfo(match: string): string {
  const authorityStart = match.indexOf('://') + 3
  const at = match.lastIndexOf('@')
  if (at < authorityStart) return match
  const colon = match.indexOf(':', authorityStart)
  if (colon === -1 || colon > at) return match
  return `${match.slice(0, colon + 1)}${REDACTED}${match.slice(at)}`
}

/** Luhn checksum, used to recognise card numbers. */
export function luhnValid(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Is this integer (a number or BigInt) probably a card number? 13–19 digits and Luhn-valid.
 *
 * Integers starting with `1` are excluded on purpose: epoch timestamps in milliseconds,
 * microseconds and nanoseconds (13, 16 and 19 digits) all start with `1` until 2033, and one in ten
 * would pass the Luhn check, so treating them as cards would hide ordinary timing data. No major
 * card network issues numbers starting with `1`.
 */
export function looksLikeCardNumber(value: number | bigint): boolean {
  if (typeof value === 'number' && !Number.isInteger(value)) return false
  if (value < 0) return false
  const digits = typeof value === 'bigint' ? value.toString() : value.toFixed(0)
  return digits.length >= 13 && digits.length <= 19 && digits[0] !== '1' && luhnValid(digits)
}

/** Make sure a custom pattern is global, so every occurrence is replaced. */
export function asGlobal(re: RegExp): RegExp {
  return re.global ? re : new RegExp(re.source, `${re.flags}g`)
}

/**
 * Redact secret patterns inside a string (built-ins + `extraPatterns`).
 *
 * @example
 * redactString('db=postgres://app:hunter2@db:5432/x') // 'db=postgres://app:[REDACTED]@db:5432/x'
 */
export function redactString(
  value: string,
  options: PatternOptions = DEFAULT_PATTERN_OPTIONS,
): string {
  let out = value
  // Short strings can't contain the long patterns; skip the regexes for them (hot path). A short
  // query parameter (`?pin=1234`) still needs the query-string rule, hence the `=` check.
  const short = out.length < 13
  if (
    !short ||
    out.includes('eyJ') ||
    out.includes('://') ||
    out.includes('=') ||
    out.includes(':')
  ) {
    for (const p of PATTERNS) {
      if (options.disable.has(p.rule)) continue
      p.re.lastIndex = 0
      if (!p.re.test(out)) continue
      p.re.lastIndex = 0
      out =
        typeof p.replace === 'string' ? out.replace(p.re, p.replace) : out.replace(p.re, p.replace)
    }
  }
  for (const re of options.extraPatterns) {
    const g = asGlobal(re)
    g.lastIndex = 0
    out = out.replace(g, REDACTED)
  }
  return out
}
