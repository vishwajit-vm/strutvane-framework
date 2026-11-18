/**
 * After-commit callbacks and model lifecycle events, on every engine.
 *
 * Found by the search package (2026-11-18): with no model events it overrode `save()` and
 * `forceDelete()` in a mixin, and with no `afterCommit()` it indexed rows of transactions that
 * later rolled back. These tests pin both: events fire once per real change, after the commit,
 * never for rolled-back work, and carry no hidden columns.
 */
import { describe, expect, test } from 'vitest'
import {
  afterCommit,
  type ModelEventDispatcher,
  type ModelEventPayload,
  modelEventName,
  runWithModelEvents,
  transaction,
} from '../../../src/database/index.ts'
import { Post } from './fixtures/app/models/post.ts'
import { Tag } from './fixtures/app/models/tag.ts'
import { type Engine, engines, engineTitle, useEngine } from './support/engines.ts'
import { makePost, makeTag, makeUser } from './support/seed.ts'

interface Seen {
  readonly type: string
  readonly payload: ModelEventPayload
}

/** A dispatcher that records events, optionally interested in only some of them. */
function recorder(interested: (type: string) => boolean = () => true): {
  readonly dispatcher: ModelEventDispatcher
  readonly seen: Seen[]
  readonly asked: string[]
} {
  const seen: Seen[] = []
  const asked: string[] = []
  return {
    seen,
    asked,
    dispatcher: {
      wants: (type) => {
        asked.push(type)
        return interested(type)
      },
      dispatch: async (type, payload) => {
        seen.push({ type, payload })
      },
    },
  }
}

function suite(engine: Engine): void {
  const connection = useEngine(engine)

  test('afterCommit runs at once outside a transaction, after COMMIT inside one, in order', async () => {
    const order: string[] = []
    await afterCommit(() => {
      order.push('immediate')
    })
    await transaction(async () => {
      await makeTag('a')
      await afterCommit(() => {
        order.push('first')
      })
      await transaction(async () => {
        await afterCommit(() => {
          order.push('from a released savepoint')
        })
      })
      await afterCommit(async () => {
        // Runs outside the transaction, after the commit: the row is visible to everyone.
        order.push(`sees ${(await Tag.query().count()).toString()} tag`)
      })
      order.push('body done')
    })
    expect(order).toEqual([
      'immediate',
      'body done',
      'first',
      'from a released savepoint',
      'sees 1 tag',
    ])
  })

  test('a rollback drops the callbacks; a rolled-back savepoint drops only its own', async () => {
    const ran: string[] = []
    await expect(
      transaction(async () => {
        await afterCommit(() => {
          ran.push('outer, rolled back')
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await transaction(async () => {
      await afterCommit(() => {
        ran.push('kept')
      })
      await transaction(async () => {
        await afterCommit(() => {
          ran.push('inner, rolled back')
        })
        throw new Error('inner')
      }).catch(() => undefined)
    })
    expect(ran).toEqual(['kept'])
  })

  test('every callback runs even when one fails; the data stays committed', async () => {
    const ran: string[] = []
    const outcome = transaction(async () => {
      await makeTag('committed')
      await afterCommit(() => {
        throw new Error('first failure')
      })
      await afterCommit(() => {
        ran.push('second')
      })
    })
    await expect(outcome).rejects.toThrow('first failure')
    expect(ran).toEqual(['second'])
    expect((await Tag.query().get()).map((tag) => tag.name)).toEqual(['committed'])
    const several = transaction(async () => {
      await afterCommit(() => {
        throw new Error('a')
      })
      await afterCommit(() => {
        throw new Error('b')
      })
    })
    await expect(several).rejects.toBeInstanceOf(AggregateError)
  })

  test('afterCommit after the transaction ended is refused, not silently run', async () => {
    let late: Promise<void> | undefined
    await transaction(async () => {
      late = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() =>
        connection().afterCommit(() => undefined),
      )
    })
    await expect(late).rejects.toThrow(/already finished/)
  })

  test('save, delete, forceDelete and restore emit created/updated/deleted/restored', async () => {
    const { dispatcher, seen } = recorder()
    await runWithModelEvents(dispatcher, async () => {
      const tag = await makeTag('news')
      tag.name = 'breaking'
      await tag.save()
      await tag.save() // nothing changed: no event
      await tag.delete() // tags have no deleted_at: a real delete
      const ada = await makeUser('Ada')
      const post = await makePost(ada, 'Hello')
      await post.delete() // soft
      await post.restore()
      await post.restore() // not deleted: no event
      await post.forceDelete()
    })
    expect(seen.map((event) => event.type)).toEqual([
      'tag.created',
      'tag.updated',
      'tag.deleted',
      'user.created',
      'post.created',
      'post.deleted',
      'post.restored',
      'post.deleted',
    ])
    const [created, updated, deleted] = seen
    expect(created?.payload).toMatchObject({
      table: 'tags',
      model: 'Tag',
      record: { name: 'news' },
    })
    expect(updated?.payload.changed).toEqual(['name'])
    expect(deleted?.payload.soft).toBe(false)
    expect(seen[5]?.payload.soft).toBe(true)
    expect(seen[7]?.payload.soft).toBe(false)
    expect(Object.isFrozen(created?.payload)).toBe(true)
  })

  test('the payload never carries hidden or secret columns', async () => {
    const { dispatcher, seen } = recorder()
    await runWithModelEvents(dispatcher, () => makeUser('Grace'))
    const record = seen[0]?.payload.record ?? {}
    expect(record).toMatchObject({ name: 'Grace' })
    for (const column of ['password', 'api_token', 'backup_phrase', 'internal_note'])
      expect(record).not.toHaveProperty(column)
  })

  test('events wait for the commit and vanish with a rollback', async () => {
    const { dispatcher, seen } = recorder()
    await runWithModelEvents(dispatcher, async () => {
      await transaction(async () => {
        await makeTag('inside')
        expect(seen).toEqual([]) // not yet: the row isn't committed
      })
      expect(seen.map((event) => event.type)).toEqual(['tag.created'])
      await transaction(async () => {
        await makeTag('rolled-back')
        throw new Error('undo')
      }).catch(() => undefined)
    })
    expect(seen.map((event) => event.payload.record['name'])).toEqual(['inside'])
  })

  test('nobody listening: no payload is built and nothing is dispatched', async () => {
    const { dispatcher, seen, asked } = recorder(() => false)
    await runWithModelEvents(dispatcher, () => makeTag('quiet'))
    expect(asked).toEqual(['tag.created'])
    expect(seen).toEqual([])
    // And without any dispatcher (a script), writes simply work.
    await expect(makeTag('script')).resolves.toBeInstanceOf(Tag)
  })
}

describe('modelEventName', () => {
  test('singular snake case of the table, for a table name or a model class', () => {
    expect(modelEventName('posts', 'created')).toBe('post.created')
    expect(modelEventName('order_lines', 'deleted')).toBe('order_line.deleted')
    expect(modelEventName(Post, 'restored')).toBe('post.restored')
  })
})

describe.each(engines)('after commit and model events on $name', (engine) => {
  describe.skipIf(engine.skipped !== undefined)(engineTitle(engine), () => suite(engine))
})
