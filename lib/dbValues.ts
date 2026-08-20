/**
 * Postgres UUID columns accept a UUID or NULL, never an empty string.
 * Form selects represent "not assigned" as an empty string, so normalize it
 * at the persistence boundary instead of leaking the UI sentinel to Supabase.
 */
export const nullableUuid = (value: string | null | undefined): string | null =>
  value?.trim() || null;
