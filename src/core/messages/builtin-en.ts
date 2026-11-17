/**
 * Built-in English messages: the last fallback in the override chain (RFC-0003 §2).
 *
 * Keys:
 * - `validation.<issue code>`: messages for {@link ValidationIssue} codes. `{attribute}` is the
 *   field's human label.
 * - `errors.<PROBLEM_CODE>.title` / `.detail`: titles and safe details for problem responses.
 *
 * @module
 */
import type { MessageDictionary } from './catalog.ts'

export const BUILTIN_EN: MessageDictionary = Object.freeze({
  // Validation issues
  'validation.required': '{attribute} is required.',
  'validation.invalid_type': '{attribute} has the wrong type.',
  'validation.invalid_format': '{attribute} is not in a valid format.',
  'validation.invalid_email': '{attribute} must be a valid email address.',
  'validation.invalid_url': '{attribute} must be a valid URL.',
  'validation.invalid_uuid': '{attribute} must be a valid id.',
  'validation.invalid_date': '{attribute} must be a valid date.',
  'validation.too_small': '{attribute} must be at least {min}.',
  'validation.too_big': '{attribute} must be at most {max}.',
  'validation.too_short':
    '{attribute} must be at least {min, plural, one {# character} other {# characters}} long.',
  'validation.too_long':
    '{attribute} must be at most {max, plural, one {# character} other {# characters}} long.',
  'validation.not_in_list': '{attribute} must be one of: {options}.',
  'validation.unique': 'This {attribute} is already taken.',
  'validation.not_found': 'The selected {attribute} does not exist.',
  'validation.file_too_large': '{attribute} is larger than {max}.',
  'validation.file_empty': '{attribute} is empty.',
  'validation.file_type_not_allowed': '{attribute} must be one of these file types: {accept}.',
  'validation.too_many_files':
    'You can upload at most {max, plural, one {# file} other {# files}} for {attribute}.',
  'validation.invalid': '{attribute} is invalid.',

  // Problem titles (same for every occurrence) and safe details
  'errors.validation_failed.title': 'Validation failed',
  'errors.validation_failed.detail': 'Some fields need your attention.',
  'errors.unauthenticated.title': 'Sign-in required',
  'errors.unauthenticated.detail': 'Please sign in to continue.',
  'errors.forbidden.title': 'Not allowed',
  'errors.forbidden.detail': "You don't have permission to do this.",
  'errors.not_found.title': 'Not found',
  'errors.not_found.detail': "We couldn't find what you were looking for.",
  'errors.conflict.title': 'Conflict',
  'errors.stale_record.title': 'Changed by someone else',
  'errors.stale_record.detail':
    'This record was changed after you opened it. Reload to see the latest version.',
  'errors.rate_limited.title': 'Too many requests',
  'errors.rate_limited.detail': 'Please wait a moment and try again.',
  'errors.payload_too_large.title': 'Request too large',
  'errors.service_unavailable.title': 'Temporarily unavailable',
  'errors.service_unavailable.detail':
    'The service is temporarily unavailable. Your changes are kept; please try again shortly.',
  'errors.internal_error.title': 'Something went wrong',
  'errors.internal_error.detail':
    'An unexpected error happened. Please try again, and contact support with the reference code if it keeps happening.',
  'errors.file_too_large.title': 'File too large',
  'errors.too_many_files.title': 'Too many files',
  'errors.file_empty.title': 'Empty file',
  'errors.file_type_not_allowed.title': 'File type not allowed',
  'errors.file_corrupt.title': 'File could not be read',
  'errors.image_dimensions_invalid.title': 'Image size not allowed',
  'errors.upload_incomplete.title': 'Upload incomplete',
  'errors.storage_unavailable.title': 'Storage temporarily unavailable',
  'errors.quota_exceeded.title': 'Storage quota exceeded',
  'errors.file_infected.title': 'File rejected',
  'errors.scan_unavailable.title': 'File scanning temporarily unavailable',
})
