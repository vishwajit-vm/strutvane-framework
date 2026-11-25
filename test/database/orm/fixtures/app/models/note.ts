import { Model } from '../../../../../../src/database/index.ts'
import { Folder } from './folder.ts'

/** A note in a folder: owner, status and team are what the random policies of the access suite read. */
export class Note extends Model('notes', {
  fillable: ['folder_id', 'owner_id', 'status', 'team', 'title', 'score'],
  allowSensitive: ['owner_id'],
}) {
  /** The folder this note is filed in (a nullable foreign key). */
  folder() {
    return this.belongsTo(Folder, 'folder_id')
  }
}

/** The same table without the `folder()` relation: boot must refuse its writable foreign key. */
export class LooseNote extends Model('notes', {
  fillable: ['folder_id', 'owner_id', 'status', 'team', 'title'],
  allowSensitive: ['owner_id'],
}) {}
