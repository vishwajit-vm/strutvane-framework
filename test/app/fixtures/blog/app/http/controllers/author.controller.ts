import { ResourceController } from '../../../../../../../src/http/app/resource-controller.ts'
import { Author } from '../../models/author.ts'

/** Author profiles: validation derived from the metadata, narrowed by Author.fillable. */
export class AuthorController extends ResourceController<typeof Author> {
  protected readonly model: typeof Author = Author
}
