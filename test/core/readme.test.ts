// Runs the README examples so the documentation can never drift from the real API.
import { expect, test } from 'vitest'
import { z } from 'zod'
import {
  createApp,
  createMessages,
  DomainError,
  defineEnv,
  defineMessages,
  defineProvider,
  EventBusToken,
  LoggerToken,
  negotiateLocale,
  runWithContext,
  token,
  toProblem,
  ValidationError,
} from '../src/index.ts'

test('README quick start', async () => {
  // --- README: Quick start ---
  interface Mailer {
    send(to: string, subject: string): Promise<void>
  }
  const MailerToken = token<Mailer>('mailer')
  const sent: string[] = []

  const env = defineEnv(z.object({ MAIL_FROM: z.email() }), { MAIL_FROM: 'noreply@acme.test' })

  const mail = defineProvider({
    name: 'mail',
    register(app) {
      app.container.singleton(MailerToken, () => ({
        send: async (to, subject) => void sent.push(`${env.MAIL_FROM} -> ${to}: ${subject}`),
      }))
    },
    boot(app) {
      app.make(EventBusToken).on('user.registered', async (event) => {
        const { email } = event.payload as { email: string }
        await app.make(MailerToken).send(email, 'Welcome!')
      })
    },
  })

  const app = createApp({ config: { app: { name: 'acme' } }, providers: [mail] })
  await app.boot()
  await runWithContext({ requestId: 'req-1' }, () =>
    app.make(EventBusToken).emit('user.registered', { email: 'ann@acme.test' }),
  )
  app.make(LoggerToken).info('Booted', { app: app.config('app.name') })
  await app.shutdown()
  // --- end ---

  expect(sent).toEqual(['noreply@acme.test -> ann@acme.test: Welcome!'])
  expect(app.state).toBe('stopped')
})

test('README errors and messages', () => {
  // --- README: Errors and messages ---
  const messages = createMessages({
    app: [
      defineMessages('en', {
        'errors.INVOICE_ALREADY_PAID.title': 'Invoice already paid',
        'errors.INVOICE_ALREADY_PAID.detail': 'Invoice {number} was paid on {date}.',
      }),
      defineMessages('de', { 'validation.required': '{attribute} ist erforderlich.' }),
    ],
  })
  const locale = negotiateLocale('de-CH, de;q=0.9, en;q=0.5', messages.locales())

  const paid = toProblem(
    new DomainError('INVOICE_ALREADY_PAID', { number: 'INV-7', date: '2026-11-01' }),
    {
      messages,
    },
  )
  // paid.detail === 'Invoice INV-7 was paid on 2026-11-01.'

  const invalid = toProblem(new ValidationError([{ path: ['dueDate'], code: 'required' }]), {
    messages,
    locale,
  })
  // invalid.fieldErrors === { dueDate: ['Due date ist erforderlich.'] }
  // --- end ---

  expect(locale).toBe('de')
  expect(paid).toMatchObject({
    status: 422,
    title: 'Invoice already paid',
    detail: 'Invoice INV-7 was paid on 2026-11-01.',
  })
  expect(invalid.fieldErrors).toEqual({ dueDate: ['Due date ist erforderlich.'] })
})
