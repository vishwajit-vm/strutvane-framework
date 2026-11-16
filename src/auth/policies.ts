/**
 * Policy discovery (CONSISTENCY #73): model `Post` → `app/policies/post.policy.ts`, whose default
 * export or `PostPolicy` export is the policy. An explicitly registered policy (or a controller's
 * own `policy` property) overrides it.
 *
 * **Path safety:** the file name comes from a model's class name, which is code, but discovery
 * still treats it as untrusted: only a PascalCase identifier is accepted, the file must resolve
 * (symlinks followed) to a file *inside* `app/policies`, and nothing else is ever imported. A
 * name like `../../secrets` can never load a file outside the folder.
 *
 * Discovery runs at boot (it imports modules), so a request never waits on it, and a missing
 * policy is a boot error for the resource controller that needs one.
 *
 * @module
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Resolver } from '../core/container.ts'
import { type Token, token } from '../core/container.ts'
import { BootError } from '../foundation/boot-error.ts'
import { buildUnchecked, type Injectable } from '../foundation/inject.ts'
import { kebabCase } from '../support/str.ts'
import type { Policy } from './gate.ts'

/**
 * Where policies are discovered, relative to the app.
 *
 * @example
 * join(basePath, POLICIES_FOLDER, 'post.policy.ts')
 */
export const POLICIES_FOLDER: string = join('app', 'policies')

/** A model class name: PascalCase letters and digits, nothing that could form a path. */
const MODEL_NAME = /^[A-Z][A-Za-z0-9]{0,99}$/

/**
 * Something a policy can be registered or discovered for: a model class (its `name`).
 *
 * @example
 * const model: PolicyTarget = Post
 */
export interface PolicyTarget {
  readonly name: string
}

/**
 * The file a model's policy is discovered in, or `undefined` when the name isn't a safe model
 * name or the file doesn't exist inside the policies folder.
 *
 * @example
 * policyFile('/srv/blog', 'BlogPost') // '/srv/blog/app/policies/blog-post.policy.ts'
 */
export function policyFile(basePath: string, modelName: string): string | undefined {
  if (!MODEL_NAME.test(modelName)) return undefined
  const folder = resolve(basePath, POLICIES_FOLDER)
  if (!existsSync(folder)) return undefined
  const realFolder = realpathSync(folder)
  for (const extension of ['ts', 'js', 'mts', 'mjs']) {
    const candidate = join(folder, `${kebabCase(modelName)}.policy.${extension}`)
    if (!existsSync(candidate)) continue
    const real = realpathSync(candidate)
    const inside = relative(realFolder, real)
    // Fail closed: a symlink (or anything else) resolving outside the folder is never loaded.
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
    if (!statSync(real).isFile()) return undefined
    return real
  }
  return undefined
}

/**
 * The app's policies: explicit registrations first, then what discovery found.
 *
 * @example
 * app.make(PolicyRegistryToken).for(Post)
 */
export class PolicyRegistry {
  readonly #basePath: string
  readonly #resolver: Resolver
  readonly #explicit = new Map<string, Policy<unknown>>()
  readonly #discovered = new Map<string, Policy<unknown> | null>()

  constructor(basePath: string, resolver: Resolver) {
    this.#basePath = basePath
    this.#resolver = resolver
  }

  /**
   * Register a policy for a model explicitly (Laravel's `Gate::policy()`); it wins over discovery.
   *
   * @example
   * app.make(PolicyRegistryToken).register(Post, new PostPolicy())
   */
  register<TModel>(model: PolicyTarget, policy: Policy<TModel>): void {
    this.#explicit.set(model.name, policy as Policy<unknown>)
  }

  /**
   * The policy for a model, or `undefined` (which denies everything). Call {@link discover} at
   * boot first for discovered policies to be known.
   *
   * @example
   * registry.for(Post)
   */
  for<TModel>(model: PolicyTarget): Policy<TModel> | undefined {
    return (this.#explicit.get(model.name) ?? this.#discovered.get(model.name) ?? undefined) as
      | Policy<TModel>
      | undefined
  }

  /**
   * Find a model's policy in `app/policies` (once; the result is cached). Returns `undefined`
   * when there is none. Throws a `BootError` when the file exists but exports no policy.
   *
   * @example
   * await registry.discover(Post)
   */
  async discover(model: PolicyTarget): Promise<Policy<unknown> | undefined> {
    const explicit = this.#explicit.get(model.name)
    if (explicit !== undefined) return explicit
    if (this.#discovered.has(model.name)) return this.#discovered.get(model.name) ?? undefined
    const file = policyFile(this.#basePath, model.name)
    if (file === undefined) {
      this.#discovered.set(model.name, null)
      return undefined
    }
    const module: Record<string, unknown> = await import(pathToFileURL(file).href)
    const exported = module['default'] ?? module[`${model.name}Policy`]
    const policy = this.#instantiate(exported)
    if (policy === undefined)
      throw new BootError(
        'invalid_policy_file',
        `${relative(this.#basePath, file)} exports no policy for ${model.name}.`,
        `Export the policy class as the default export or as ${model.name}Policy.`,
      )
    this.#discovered.set(model.name, policy)
    return policy
  }

  #instantiate(exported: unknown): Policy<unknown> | undefined {
    if (typeof exported === 'function' && exported.prototype !== undefined)
      return buildUnchecked(
        this.#resolver,
        exported as Injectable<Policy<unknown>>,
      ) as Policy<unknown>
    if (typeof exported === 'object' && exported !== null) return exported as Policy<unknown>
    return undefined
  }
}

/**
 * The container token for the app's policy registry, bound at boot.
 *
 * @example
 * app.make(PolicyRegistryToken).register(Post, new PostPolicy())
 */
export const PolicyRegistryToken: Token<PolicyRegistry> =
  token<PolicyRegistry>('strutvane.policies')
