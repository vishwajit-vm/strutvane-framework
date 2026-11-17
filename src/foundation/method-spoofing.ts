/**
 * Form method spoofing, Laravel's `<input type="hidden" name="_method" value="DELETE">`: HTML
 * forms can only send GET and POST, so a POST form may ask to be routed as PUT, PATCH or DELETE.
 *
 * The rules, chosen so spoofing can never weaken a check:
 * - only a real **POST** is ever spoofed, and only to **PUT, PATCH or DELETE** (all unsafe, so the
 *   CSRF check, which looks at the real method, applies exactly as before). Any other value
 *   (`GET`, `TRACE`, `HEAD`, nonsense) is a 400 `invalid_method_override`, like Symfony: turning a
 *   write into a read would skip the CSRF check and let a cached "GET" carry a write;
 * - only the urlencoded **body** field counts. A `?_method=` query parameter and the
 *   `X-HTTP-Method-Override` header are ignored on purpose: both can be set by things that don't
 *   build the form (links, proxies, other sites' fetch calls), and the header form has no use in
 *   a framework whose API clients can send real methods. (Multipart forms send the real method
 *   with `fetch`, or use a urlencoded form.)
 * - the body is read from a clone, capped at 64 KiB, so the controller still gets it.
 *
 * @module
 */
import { StrutvaneError } from '../core/errors/errors.ts'

const SPOOFABLE: ReadonlySet<string> = new Set(['PUT', 'PATCH', 'DELETE'])
/** Forms are small; finding `_method` never buffers more than this. */
const READ_LIMIT = 64 * 1024

/**
 * The method routing should use for a request.
 *
 * @example
 * await spoofedMethod(new Request(url, { method: 'POST', body: '_method=DELETE', headers })) // 'DELETE'
 */
export async function spoofedMethod(request: Request): Promise<string> {
  const method = request.method.toUpperCase()
  if (method !== 'POST' || request.body === null) return method
  const essence = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase()
  if (essence !== 'application/x-www-form-urlencoded') return method
  const text = await readCapped(request.clone())
  if (text === undefined) return method
  const field = new URLSearchParams(text).get('_method')
  if (field === null || field === '') return method
  const wanted = field.trim().toUpperCase()
  if (SPOOFABLE.has(wanted)) return wanted
  throw new StrutvaneError('invalid_method_override', { status: 400 })
}

/** The body as text, or `undefined` when it is bigger than the cap or can't be read. */
async function readCapped(request: Request): Promise<string | undefined> {
  const reader = request.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > READ_LIMIT) {
        // Not awaited: cancelling one branch of a cloned (tee'd) body settles only once the other
        // branch is cancelled too, so awaiting it here would hang the request.
        void reader.cancel().catch(() => undefined)
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  }
  return Buffer.concat(chunks).toString('utf8')
}
