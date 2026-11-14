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
  'errors.VALIDATION_FAILED.title': 'Validation failed',
  'errors.VALIDATION_FAILED.detail': 'Some fields need your attention.',
  'errors.UNAUTHENTICATED.title': 'Sign-in required',
  'errors.UNAUTHENTICATED.detail': 'Please sign in to continue.',
  'errors.FORBIDDEN.title': 'Not allowed',
  'errors.FORBIDDEN.detail': "You don't have permission to do this.",
  'errors.NOT_FOUND.title': 'Not found',
  'errors.NOT_FOUND.detail': "We couldn't find what you were looking for.",
  'errors.CONFLICT.title': 'Conflict',
  'errors.STALE_RECORD.title': 'Changed by someone else',
  'errors.STALE_RECORD.detail':
    'This record was changed after you opened it. Reload to see the latest version.',
  'errors.RATE_LIMITED.title': 'Too many requests',
  'errors.RATE_LIMITED.detail': 'Please wait a moment and try again.',
  'errors.PAYLOAD_TOO_LARGE.title': 'Request too large',
  'errors.SERVICE_UNAVAILABLE.title': 'Temporarily unavailable',
  'errors.SERVICE_UNAVAILABLE.detail':
    'The service is temporarily unavailable. Your changes are kept; please try again shortly.',
  'errors.INTERNAL_ERROR.title': 'Something went wrong',
  'errors.INTERNAL_ERROR.detail':
    'An unexpected error happened. Please try again, and contact support with the reference code if it keeps happening.',
  'errors.FILE_TOO_LARGE.title': 'File too large',
  'errors.TOO_MANY_FILES.title': 'Too many files',
  'errors.FILE_EMPTY.title': 'Empty file',
  'errors.FILE_TYPE_NOT_ALLOWED.title': 'File type not allowed',
  'errors.FILE_CORRUPT.title': 'File could not be read',
  'errors.IMAGE_DIMENSIONS_INVALID.title': 'Image size not allowed',
  'errors.UPLOAD_INCOMPLETE.title': 'Upload incomplete',
  'errors.STORAGE_UNAVAILABLE.title': 'Storage temporarily unavailable',
  'errors.QUOTA_EXCEEDED.title': 'Storage quota exceeded',
  'errors.FILE_INFECTED.title': 'File rejected',
  'errors.SCAN_UNAVAILABLE.title': 'File scanning temporarily unavailable',
})
