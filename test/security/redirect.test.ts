/**
 * The open-redirect guard and the redirect helper shape (ported from spike 12): the 26 hostile
 * payloads, `intended()` falling back silently, `to()` refusing loudly, `away()` as the one
 * explicit way off-site.
 */
import { describe, expect, it } from 'vitest'
import { BootError } from '../../src/foundation/boot-error.ts'
import { INTENDED_PARAMETER, Redirector, safeRedirectTarget } from '../../src/security/redirect.ts'

const APP = 'https://blog.example.com'

describe('the open-redirect guard', () => {
  it('allows same-origin paths only, normalised', () => {
    expect(safeRedirectTarget('/posts?page=2#top', APP)).toBe('/posts?page=2#top')
    expect(safeRedirectTarget('/a/../b', APP)).toBe('/b')
    expect(safeRedirectTarget('/posts/my%20post', new URL(APP))).toBe('/posts/my%20post')
  })

  it.each([
    '//evil.com',
    '/\\evil.com',
    '\\\\evil.com',
    '/%2F%2Fevil.com',
    '%2F%2Fevil.com',
    '/%5Cevil.com',
    '/%255Cevil.com',
    '/%252F%252Fevil.com',
    '/.//evil.com',
    '/..//evil.com',
    '////evil.com',
    'https://evil.com',
    'https:evil.com',
    'https://blog.example.com.evil.com/',
    'https://blog.example.com@evil.com/',
    'http://blog.example.com/',
    'javascript:alert(1)',
    ' //evil.com',
    '/\t/evil.com',
    '/%09/evil.com',
    '/\r\nLocation: https://evil.com',
    '/%0d%0aSet-Cookie:%20a=b',
    '',
    'evil.com',
    `/${'a'.repeat(3000)}`,
    '/%E0%A4%A',
  ])('refuses %j', (payload) => {
    expect(safeRedirectTarget(payload, APP)).toBeUndefined()
  })

  it('refuses encodings nested deeper than it inspects', () => {
    expect(safeRedirectTarget('/%25252F%25252Fevil.com', APP)).toBeUndefined()
  })
})

describe('the Redirector', () => {
  const redirect = new Redirector(APP)
  const location = (response: Response): string | null => response.headers.get('location')

  it('intended() goes to a same-origin path, and falls back for hostile values', () => {
    const at = (query: string): URL => new URL(`${APP}/login/done${query}`)
    expect(location(redirect.intended(at('?intended=%2Fposts%2F7'), '/dashboard'))).toBe('/posts/7')
    for (const query of [
      '?intended=%2F%2Fevil.com',
      '?intended=https%3A%2F%2Fevil.com',
      '?intended=%2F%5Cevil.com',
      '',
    ])
      expect(location(redirect.intended(at(query), '/dashboard')), query).toBe('/dashboard')
    const request = new Request(`${APP}/x?${INTENDED_PARAMETER}=%2Fa`)
    expect(location(redirect.intended(request))).toBe('/a')
    expect(location(redirect.intended({ query: new URLSearchParams('') }))).toBe('/')
    expect(redirect.intended({ query: new URLSearchParams('') }, '/', 303).status).toBe(303)
  })

  it('to() refuses anything off-site loudly; away() is explicit and http(s) only', () => {
    const response = redirect.to('/posts', 303)
    expect(response.status).toBe(303)
    expect(location(response)).toBe('/posts')
    expect(() => redirect.to('//evil.com')).toThrow(BootError)
    expect(() => redirect.to('//evil.com')).toThrow('not a same-origin path')
    expect(() => redirect.intended(new URL(APP), 'https://evil.com')).toThrow(BootError)
    expect(location(redirect.away('https://partner.example/x'))).toBe('https://partner.example/x')
    for (const bad of ['javascript:alert(1)', 'not a url', 'https://user:pw@evil.example/'])
      expect(() => redirect.away(bad), bad).toThrow('absolute http(s) URL')
    // The URL parser strips CR/LF, so a header can never be split through away().
    expect(location(redirect.away('https://a.example/\r\nSet-Cookie: x=1'))).toBe(
      'https://a.example/Set-Cookie:%20x=1',
    )
    expect(() => new Redirector('not a url')).toThrow(BootError)
  })
})
