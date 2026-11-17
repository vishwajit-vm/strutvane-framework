import type { HttpRequestHookPayload } from '../../../../../../src/contracts/http-hooks.ts'
import { HooksToken } from '../../../../../../src/core/tokens.ts'
import type { Application } from '../../../../../../src/foundation/application.ts'
import { ServiceProvider } from '../../../../../../src/foundation/provider.ts'
import { Author } from '../models/author.ts'

/**
 * The fixture's AppServiceProvider. It also stands in for the auth package: an `http.onRequest`
 * handler that resolves the author owning a bearer token, the way @strutvane/auth resolves users.
 */
export class AppServiceProvider extends ServiceProvider {
  override boot(app: Application): void {
    app.make(HooksToken).on(
      'http.onRequest',
      (payload) => {
        const request = payload as HttpRequestHookPayload
        const match = /^Bearer ([\x21-\x7e]+)$/i.exec(
          request.request.headers.get('authorization') ?? '',
        )
        const token = match?.[1]
        if (token === undefined || request.actor !== null) return undefined
        return { ...request, actor: Author.byToken(token) }
      },
      { name: 'blog.bearer' },
    )
    app.navigation.add({
      name: 'posts',
      label: 'Posts',
      path: '/posts',
      icon: 'file-text',
      group: 'Content',
      order: 10,
      permission: null,
    })
    app.navigation.add({
      name: 'authors',
      label: 'Authors',
      path: '/authors',
      icon: 'users',
      group: 'Content',
      order: 20,
      permission: 'authors.view',
    })
  }
}
