import { Model } from '../../../../../../src/database/index.ts'
import { Note } from './note.ts'

/** A folder of notes, with its own owner and team (and its own policy). */
export class Folder extends Model('folders', {
  fillable: ['owner_id', 'team', 'name'],
  allowSensitive: ['owner_id'],
}) {
  /** The notes filed here. */
  notes() {
    return this.hasMany(Note, 'folder_id')
  }
}
