/**
 * A blog post, in memory, implementing the `ResourceModel` contract: route key `slug`, soft
 * deletes, a unique slug, and a random suffix (not a counter) when a slug collides.
 */
import { randomBytes } from 'node:crypto'
import { now } from '../../../../../../src/foundation/helpers.ts'
import type {
  Constraint,
  ResourceMetadata,
  ResourcePage,
} from '../../../../../../src/http/app/resource-model.ts'
import { db, listRows, matches, type Row } from './store.ts'

const METADATA: ResourceMetadata = {
  table: 'posts',
  model: 'Post',
  label: { singular: 'Post', plural: 'Posts' },
  primaryKey: 'id',
  fields: [
    {
      name: 'id',
      label: 'Id',
      kind: 'id',
      cast: 'integer',
      nullable: false,
      required: false,
      fillable: false,
      unique: true,
      hidden: false,
    },
    {
      name: 'title',
      label: 'Title',
      kind: 'string',
      cast: 'string',
      nullable: false,
      required: true,
      fillable: true,
      unique: false,
      hidden: false,
      maxLength: 200,
    },
    {
      name: 'slug',
      label: 'Slug',
      kind: 'string',
      cast: 'string',
      nullable: false,
      required: false,
      fillable: true,
      unique: true,
      hidden: false,
    },
    {
      name: 'body',
      label: 'Body',
      kind: 'text',
      cast: 'string',
      nullable: true,
      required: false,
      fillable: true,
      unique: false,
      hidden: false,
    },
    {
      name: 'status',
      label: 'Status',
      kind: 'string',
      cast: 'string',
      nullable: false,
      required: false,
      fillable: true,
      unique: false,
      hidden: false,
      options: ['draft', 'published'],
    },
    {
      name: 'author_id',
      label: 'Author',
      kind: 'foreign_id',
      cast: 'integer',
      nullable: false,
      required: true,
      fillable: true,
      unique: false,
      hidden: false,
      references: 'users',
    },
    {
      name: 'published_at',
      label: 'Published at',
      kind: 'datetime',
      cast: 'datetime',
      nullable: true,
      required: false,
      fillable: true,
      unique: false,
      hidden: false,
    },
  ],
}

/** Lower-case words joined by dashes. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A post record. */
export class Post {
  /** `author_id` is not here: the controller sets it from the signed-in user. */
  static readonly fillable: readonly string[] = ['title', 'slug', 'body', 'status']
  #row: Row

  constructor(row: Row) {
    this.#row = row
  }

  get id(): number {
    return Number(this.#row['id'])
  }

  get slug(): string {
    return String(this.#row['slug'])
  }

  get status(): 'draft' | 'published' {
    return this.#row['status'] === 'published' ? 'published' : 'draft'
  }

  get author_id(): number {
    return Number(this.#row['author_id'])
  }

  static metadata(): ResourceMetadata {
    return METADATA
  }

  static async paginate(
    query: URLSearchParams,
    constraints: readonly Constraint[],
  ): Promise<ResourcePage<Post>> {
    const rows = db()
      .table('posts')
      .rows.filter((row) => row['deleted_at'] === null && matches(row, constraints))
    const page = listRows(rows, query, { sortable: ['id', 'title'], filterable: ['status'] })
    return { data: page.rows.map((row) => new Post(row)), meta: page.meta }
  }

  static async createFromValidated(values: Readonly<Record<string, unknown>>): Promise<Post> {
    const base = slugify(String(values['slug'] ?? values['title'] ?? 'post')) || 'post'
    const taken = await Post.isTaken('slug', base)
    // A random suffix, never a counter: `hello-2` would reveal that a hidden `hello` exists.
    const slug = taken ? `${base}-${randomBytes(3).toString('hex').slice(0, 4)}` : base
    return new Post(
      db().insert('posts', {
        body: null,
        status: 'draft',
        published_at: null,
        deleted_at: null,
        ...(values as Row),
        slug,
      }),
    )
  }

  static async resolveRouteBinding(value: string, field?: string): Promise<Post | null> {
    const column = field ?? 'slug'
    const row = db()
      .table('posts')
      .rows.find(
        (candidate) => candidate['deleted_at'] === null && String(candidate[column]) === value,
      )
    return row === undefined ? null : new Post(row)
  }

  static async isTaken(
    column: string,
    value: string | number,
    exceptKey?: string | number,
  ): Promise<boolean> {
    return db()
      .table('posts')
      .rows.some((row) => row[column] === value && String(row['id']) !== String(exceptKey))
  }

  routeKey(field?: string): string | number {
    const value = this.#row[field ?? 'slug']
    return typeof value === 'number' ? value : String(value)
  }

  toJSON(): unknown {
    const { deleted_at: _deleted, ...visible } = this.#row
    return visible
  }

  async updateFromValidated(values: Readonly<Record<string, unknown>>): Promise<void> {
    Object.assign(this.#row, values)
  }

  async publish(): Promise<void> {
    this.#row['status'] = 'published'
    this.#row['published_at'] = now().toISOString()
  }

  async delete(): Promise<void> {
    this.#row['deleted_at'] = now().toISOString()
  }
}
