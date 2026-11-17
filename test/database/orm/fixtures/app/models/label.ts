import { Model } from '../../../../../../src/database/index.ts'

/** A tenant's label. Names are unique per tenant (`unique(['tenant_id', 'name'])`), never globally. */
export class Label extends Model('labels', { fillable: ['name'] }) {}
