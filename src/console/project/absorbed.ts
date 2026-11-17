/**
 * Packages that `@strutvane/framework` absorbed (CONSOLIDATION.md), and the launcher it replaced.
 *
 * Why this matters to an app: each of these carries its own copy of the kernel or declares the
 * same bins as the framework.
 * - `@strutvane/core` / `contracts` / `devkit` / `cli` next to the framework is a **second
 *   kernel**: container tokens are `Symbol()`s and errors are checked with `instanceof`, so a
 *   provider that binds the old `LoggerToken` is invisible to the framework, and an old
 *   `NotFoundError` renders as a 500.
 * - `@strutvane/cli` declares `strutvane-cli` and the `strutvane` launcher declares `strutvane`;
 *   the framework declares both. Which one `npm run` executes then depends on install order.
 *
 * `node strut doctor` fails on any of them so the app fails closed with a fix, not at run time.
 *
 * @module
 */

/** The absorbed package, and where its code lives now. */
export const ABSORBED_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  '@strutvane/contracts': '@strutvane/framework/contracts',
  '@strutvane/core': '@strutvane/framework/core',
  '@strutvane/devkit': '@strutvane/framework/devkit',
  '@strutvane/cli': 'the `strutvane` bin of @strutvane/framework',
  strutvane: 'the `strutvane` bin of @strutvane/framework',
})

/** Whether `name` was absorbed into the framework (and must not be installed next to it). */
export function isAbsorbedPackage(name: string): boolean {
  return Object.hasOwn(ABSORBED_PACKAGES, name)
}
