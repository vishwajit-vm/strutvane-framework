import { Model } from '../../../../../../src/database/index.ts'
import { Project } from './project.ts'

/**
 * A task inside a project. `project_id` is fillable on purpose here: the composite foreign key
 * (tenant_id, project_id) → projects (tenant_id, id) makes pointing at another tenant's project
 * impossible in the database itself.
 */
export class Task extends Model('tasks', { fillable: ['project_id', 'title', 'done'] }) {
  /** The project this task belongs to. */
  project() {
    return this.belongsTo(Project, 'project_id')
  }
}
