/**
 * The npm release channel (dist-tag) of a Strutvane version, and how to name a first-party
 * package on that channel in an install command.
 *
 * **Why.** Before 1.0 every Strutvane package is published under a prerelease dist-tag (`next`),
 * while `latest` still points at the name placeholder (`0.0.0-reserved.0`). A bare
 * `pnpm add @strutvane/auth` resolves `latest` and installs the placeholder, so every install
 * this CLI runs or suggests must name the channel the CLI itself was released on. A pinned
 * version would not do: the packages live in different repositories and are versioned
 * independently, so the CLI's version may not exist for another package. The channel is what all
 * release flows share; it is derived from the prerelease id exactly as the release script
 * (`.github/scripts/publish-if-new.mjs`, `distTagFor`) derives the tag it publishes to.
 *
 * The `strutvane` launcher has the same rule in `launcher.ts` (it cannot import this package);
 * keep the two in step.
 *
 * @module
 */

/** Strict semver (npm's grammar), capturing the prerelease part. Same as the release script's. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/
/** A dist-tag the release script can publish to: lowercase, starts with a letter. */
const DIST_TAG = /^[a-z][a-z0-9-]{0,63}$/

/**
 * The dist-tag `version` was released under: `1.2.3` → `latest`; `0.1.0-next.4` → `next`;
 * `0.2.0-canary.7` → `canary`.
 *
 * The result is passed to package managers (through a shell on Windows), so anything unexpected
 * (not strict semver, a numeric or upper-case id, `latest` itself, an id over 64 characters)
 * falls back to `latest` instead of being passed on.
 */
export function releaseChannel(version: string): string {
  const pre = SEMVER.exec(version)?.[4]
  if (pre === undefined) return 'latest'
  const id = pre.split('.')[0] ?? ''
  return DIST_TAG.test(id) && id !== 'latest' ? id : 'latest'
}

/**
 * How to name `pkg` in an install command for the channel of `version`: the bare name on
 * `latest` (what people type anyway), `pkg@<channel>` otherwise (`@strutvane/auth@next`).
 */
export function channelSpec(pkg: string, version: string): string {
  const channel = releaseChannel(version)
  return channel === 'latest' ? pkg : `${pkg}@${channel}`
}
