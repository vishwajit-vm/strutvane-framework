import { z } from 'zod'
import {
  FormRequest,
  type StandardSchema,
} from '../../../../../../../src/validation/form-request.ts'

const fields = {
  title: z
    .string({ error: 'Title is required.' })
    .trim()
    .min(3, { error: 'Title must be at least 3 characters.' })
    .max(200),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    error: 'Slug may only contain lower-case letters, digits and single dashes.',
  }),
  body: z.string().max(50_000).nullable(),
  status: z.enum(['draft', 'published'], { error: 'Status must be draft or published.' }),
}

/** What a valid create body becomes. */
export interface StorePost {
  title: string
  slug?: string | undefined
  body?: string | null | undefined
  status: 'draft' | 'published'
}

/** What a valid update body becomes (every field optional: PATCH). */
export interface UpdatePost {
  title?: string | undefined
  slug?: string | undefined
  body?: string | null | undefined
  status?: 'draft' | 'published' | undefined
}

const storeSchema: StandardSchema<StorePost> = z.object({
  title: fields.title,
  slug: fields.slug.optional(),
  body: fields.body.optional(),
  status: fields.status.default('draft'),
})
const updateSchema: StandardSchema<UpdatePost> = z.object(fields).partial()

/** Validation for POST /api/posts. */
export class StorePostRequest extends FormRequest<StorePost> {
  rules(): StandardSchema<StorePost> {
    return storeSchema
  }
}

/** Validation for PATCH /api/posts/{post}. */
export class UpdatePostRequest extends FormRequest<UpdatePost> {
  rules(): StandardSchema<UpdatePost> {
    return updateSchema
  }
}
