// Ignored by discovery (leading underscore): helpers can live next to models without being models.
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
