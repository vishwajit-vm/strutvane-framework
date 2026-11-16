import { Model } from '#orm'

/** A project owned by a team (`team_id`): used to show the tenant column is configuration, not a magic name. */
export class TeamProject extends Model('team_projects', { fillable: ['name'] }) {}
