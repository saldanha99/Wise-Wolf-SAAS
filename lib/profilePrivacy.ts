import { supabase } from './supabase';

export type AuthorizedProfilePrivate = Record<string, unknown>;

/**
 * Carrega somente os campos privados que o banco autorizou para o usuário
 * atual. Professores podem ler o próprio dossiê; direção pode ler o tenant.
 */
export async function loadAuthorizedProfilePrivate(
  profileId?: string,
): Promise<AuthorizedProfilePrivate> {
  const { data, error } = await supabase.rpc('get_authorized_profile_private', {
    p_profile_id: profileId || null,
  });
  if (error) throw error;
  return (data as AuthorizedProfilePrivate | null) || {};
}
