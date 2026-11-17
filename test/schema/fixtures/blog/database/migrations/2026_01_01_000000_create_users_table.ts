import { migration } from '../../../../../../src/entries/schema.ts'

export default migration({
  up(schema) {
    schema.create('users', (t) => {
      t.id()
      t.string('name')
      t.string('email').unique()
      // Nullable: people who sign in with SSO never get a password.
      t.string('password').nullable()
      t.timestamps()
    })
  },
  down(schema) {
    schema.dropIfExists('users')
  },
})
