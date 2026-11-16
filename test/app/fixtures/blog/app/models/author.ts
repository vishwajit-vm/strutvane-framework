/**
 * An author: a resource record and, being the app's user type, an `Actor` too (the auth hook would
 * resolve it). In-memory, implementing the `ResourceModel` contract.
 */
import type { ActorType } from '../../../../../../src/contracts/actor.ts'
import type {
  Constraint,
  ResourceMetadata,
  ResourcePage,
} from '../../../../../../src/http/app/resource-model.ts'
import { db, listRows, matches, type Row } from './store.ts'

const METADATA: ResourceMetadata = {
  table: 'authors',
  model: 'Author',
  label: { singular: 'Author', plural: 'Authors' },
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
      name: 'name',
      label: 'Name',
      kind: 'string',
      cast: 'string',
      nullable: false,
      required: true,
      fillable: true,
      unique: false,
      hidden: false,
      maxLength: 100,
    },
    {
      name: 'email',
      label: 'Email',
      kind: 'string',
      cast: 'string',
      nullable: false,
      required: true,
      fillable: true,
      unique: true,
      hidden: false,
    },
    {
      name: 'bio',
      label: 'Bio',
      kind: 'text',
      cast: 'string',
      nullable: true,
      required: false,
      fillable: true,
      unique: false,
      hidden: false,
    },
    {
      name: 'is_admin',
      label: 'Is admin',
      kind: 'boolean',
      cast: 'boolean',
      nullable: false,
      required: false,
      fillable: true,
      unique: false,
      hidden: false,
    },
    {
      name: 'api_token',
      label: 'Api token',
      kind: 'string',
      cast: 'string',
      nullable: true,
      required: false,
      fillable: true,
      unique: false,
      hidden: true,
    },
  ],
}

/** An author record. */
export class Author {
  /** What the API may write: `is_admin` and `api_token` are deliberately absent. */
  static readonly fillable: readonly string[] = ['name', 'email', 'bio']
  readonly id: string
  readonly type: ActorType = 'user'
  readonly attrs: Readonly<Record<string, unknown>> = {}
  #row: Row

  constructor(row: Row) {
    this.#row = row
    this.id = String(row['id'])
  }

  get name(): string {
    return String(this.#row['name'])
  }

  get email(): string {
    return String(this.#row['email'])
  }

  get is_admin(): boolean {
    return this.#row['is_admin'] === true
  }

  get roles(): readonly string[] {
    return this.is_admin ? ['admin'] : []
  }

  static metadata(): ResourceMetadata {
    return METADATA
  }

  static async paginate(
    query: URLSearchParams,
    constraints: readonly Constraint[],
  ): Promise<ResourcePage<Author>> {
    const rows = db()
      .table('authors')
      .rows.filter((row) => matches(row, constraints))
    const page = listRows(rows, query, { sortable: ['id', 'name'], filterable: ['name'] })
    return { data: page.rows.map((row) => new Author(row)), meta: page.meta }
  }

  static async createFromValidated(values: Readonly<Record<string, unknown>>): Promise<Author> {
    return new Author(
      db().insert('authors', { bio: null, is_admin: false, api_token: null, ...(values as Row) }),
    )
  }

  static async resolveRouteBinding(value: string, field?: string): Promise<Author | null> {
    // Refuse non-digits before any lookup: `2abc` is not author 2.
    if ((field ?? 'id') === 'id' && !/^\d+$/.test(value)) return null
    const row = db()
      .table('authors')
      .rows.find((candidate) => String(candidate[field ?? 'id']) === value)
    return row === undefined ? null : new Author(row)
  }

  static async isTaken(
    column: string,
    value: string | number,
    exceptKey?: string | number,
  ): Promise<boolean> {
    return db()
      .table('authors')
      .rows.some((row) => row[column] === value && String(row['id']) !== String(exceptKey))
  }

  /** Find the author owning an API token (the fixture's stand-in for the auth hook). */
  static byToken(token: string): Author | null {
    const row = db()
      .table('authors')
      .rows.find((candidate) => candidate['api_token'] === token)
    return row === undefined ? null : new Author(row)
  }

  routeKey(field?: string): string | number {
    return String(this.#row[field ?? 'id'])
  }

  toJSON(): unknown {
    const { api_token: _hidden, ...visible } = this.#row
    return visible
  }

  async updateFromValidated(values: Readonly<Record<string, unknown>>): Promise<void> {
    Object.assign(this.#row, values)
  }

  async delete(): Promise<void> {
    const table = db().table('authors')
    table.rows = table.rows.filter((row) => row !== this.#row)
  }
}
