import { Model } from '../../../../../../src/database/index.ts'
import { Customer } from './customer.ts'

/** An order, which belongs to a customer (a foreign key that restricts deletes). */
export class Order extends Model('orders', { fillable: ['customer_id', 'number', 'total'] }) {
  /** The customer who placed the order. */
  customer() {
    return this.belongsTo(Customer, 'customer_id')
  }
}
