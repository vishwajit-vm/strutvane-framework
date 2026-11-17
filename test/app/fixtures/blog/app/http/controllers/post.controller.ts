import { authorize, hasAdminRole } from '../../../../../../../src/auth/gate.ts'
import { EventBusToken } from '../../../../../../../src/core/tokens.ts'
import { app } from '../../../../../../../src/foundation/helpers.ts'
import type { HttpContext } from '../../../../../../../src/http/app/context.ts'
import { ResourceController } from '../../../../../../../src/http/app/resource-controller.ts'
import type { Constraint } from '../../../../../../../src/http/app/resource-model.ts'
import { route } from '../../../../../../../src/routing/route-helper.ts'
import { Post } from '../../models/post.ts'
import { StorePostRequest, UpdatePostRequest } from '../requests/post.request.ts'

/** The posts API: index, show, store, update and destroy are inherited. The policy is discovered. */
export class PostController extends ResourceController<typeof Post> {
  protected readonly model: typeof Post = Post
  protected override readonly storeRequest: StorePostRequest = new StorePostRequest()
  protected override readonly updateRequest: UpdatePostRequest = new UpdatePostRequest()

  /** Guests see published posts; authors also their own drafts; admins everything. */
  protected override indexConstraints(ctx: HttpContext): Constraint[] {
    if (hasAdminRole(ctx.user)) return []
    const visible: Constraint[] = [{ column: 'status', equals: 'published' }]
    if (ctx.user !== null) visible.push({ column: 'author_id', equals: Number(ctx.user.id) })
    return [{ anyOf: visible }]
  }

  /** The author is whoever is signed in, never a value the client sends. */
  protected override prepareForStore(
    values: Record<string, unknown>,
    ctx: HttpContext,
  ): Record<string, unknown> {
    return { ...values, author_id: Number(ctx.requireUser().id) }
  }

  /** A custom action: 404 when the user can't see the post, 403 when they can't change it. */
  async publish(ctx: HttpContext): Promise<Response> {
    const post = await this.visible(ctx)
    await authorize(await this.resolvedPolicy(), 'update', ctx.user, post)
    await post.publish()
    await app().container.make(EventBusToken).emit('post.published', { id: post.id })
    return ctx.json({ data: post, links: { self: route('posts.show', { post }) } })
  }
}
