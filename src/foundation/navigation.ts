/**
 * The navigation registry: sidebar entries from the app and its packages, in the shape the UI
 * reads (CONSISTENCY #50). The UI hides entries whose `permission` the user lacks; the registry
 * itself only collects and orders them.
 *
 * @module
 */
import { BootError } from './boot-error.ts'

/**
 * One sidebar entry (CONSISTENCY #50: `order`, not `sort`).
 *
 * @example
 * const item: NavigationItem = { name: 'billing', label: 'Billing', path: '/billing', icon: 'credit-card', group: 'Account', order: 50, permission: 'billing.view' }
 */
export interface NavigationItem {
  /** A unique, stable id (`billing`, `posts`). */
  readonly name: string
  readonly label: string
  /** Where the entry links to (a path, often `route('…')`). */
  readonly path: string
  readonly icon: string
  readonly group: string
  readonly order: number
  /** A small count or label next to the entry. */
  readonly badge?: string | number
  /** The permission needed to see it (`posts.view`), or `null` for everyone. */
  readonly permission: string | null
}

/**
 * The registry. `app.navigation.add(…)` in a provider's `boot()`.
 *
 * @example
 * app.navigation.add({ name: 'posts', label: 'Posts', path: '/posts', icon: 'file-text', group: 'Content', order: 10, permission: 'posts.view' })
 */
export class NavigationRegistry {
  readonly #items = new Map<string, NavigationItem>()

  /**
   * Add an entry. Two entries with the same `name` are a `BootError` (a package and the app
   * fighting over one slot should be decided, not guessed).
   *
   * @example
   * app.navigation.add({ name: 'billing', label: 'Billing', path: '/billing', icon: 'card', group: 'Account', order: 50, permission: null })
   */
  add(item: NavigationItem): void {
    if (this.#items.has(item.name))
      throw new BootError(
        'duplicate_navigation_item',
        `Two navigation entries are named "${item.name}".`,
        'Give each entry its own name, or remove one of them.',
      )
    if (!Number.isFinite(item.order))
      throw new BootError(
        'invalid_navigation_item',
        `The navigation entry "${item.name}" needs a numeric order.`,
        'Pass order: 10 (lower comes first within its group).',
      )
    this.#items.set(item.name, Object.freeze({ ...item }))
  }

  /**
   * Entries sorted by group, then order, then label.
   *
   * @example
   * app.navigation.items.map((item) => item.label)
   */
  get items(): readonly NavigationItem[] {
    return [...this.#items.values()].sort(
      (a, b) =>
        a.group.localeCompare(b.group) || a.order - b.order || a.label.localeCompare(b.label),
    )
  }
}
