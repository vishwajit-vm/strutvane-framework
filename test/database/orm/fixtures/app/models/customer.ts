import { Model } from '../../../../../../src/database/index.ts'
import { Order } from './order.ts'

/** A customer: unique e-mail, an enum, a decimal, soft deletes and a secret-looking column. */
export class Customer extends Model('customers', {
  fillable: ['name', 'email', 'status', 'credit_limit', 'notes'],
}) {
  /** The customer's orders. */
  orders() {
    return this.hasMany(Order, 'customer_id')
  }
}
