import { Model } from '../../../../../../src/database/index.ts'
import { Label } from './label.ts'
import { Task } from './task.ts'

/**
 * A tenant-scoped model: the `projects` table has the tenant column, so every query is limited
 * to the active tenant, creates are stamped with it, and nothing works without one.
 */
export class Project extends Model('projects', { fillable: ['name', 'budget'] }) {
  /** The project's tasks (a tenant child table: it carries tenant_id too). */
  tasks() {
    return this.hasMany(Task, 'project_id')
  }

  /** Labels, through the tenant-scoped project_label pivot. */
  labels() {
    return this.belongsToMany(Label, 'project_label', 'project_id', 'label_id')
  }
}
