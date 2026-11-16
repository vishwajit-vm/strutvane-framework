import type { HttpContext } from '../../../../../../../src/http/app/context.ts'
import { Controller } from '../../../../../../../src/http/app/resource-controller.ts'
import { type BlogDb, BlogDbToken } from '../../models/store.ts'

/** Admin statistics: shows constructor injection (checked against the constructor by the compiler). */
export class StatsController extends Controller {
  static readonly inject: readonly [typeof BlogDbToken] = [BlogDbToken] as const
  readonly #db: BlogDb

  constructor(database: BlogDb) {
    super()
    this.#db = database
  }

  async show(ctx: HttpContext): Promise<Response> {
    const posts = this.#db.table('posts').rows.filter((row) => row['deleted_at'] === null).length
    return ctx.json({ data: { posts, authors: this.#db.table('authors').rows.length } })
  }
}
