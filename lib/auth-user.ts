import { PROFILE_SAFE_COLS } from "../constants";
import { User, UserRole } from "../types";
import { supabase } from "./supabase";
import { loadAuthorizedProfilePrivate } from "./profilePrivacy";

type ProfileRecord = Record<string, any>;

/**
 * Converte o perfil persistido no formato de usuário consumido pelo App.
 * Mantido em um único lugar para login e restauração de sessão não divergirem.
 */
export async function mapProfileToAppUser(
  profile: ProfileRecord,
): Promise<User> {
  // Dados privados não fazem parte do diretório de profiles. O próprio usuário
  // recebe apenas o seu registro por RPC; professores não conseguem apontar a
  // chamada para um aluno.
  const [{ data: myPay }, { data: accessContext }, privateProfile] = await Promise.all([
    supabase.rpc("get_my_pay"),
    supabase.rpc("get_my_access_context").maybeSingle(),
    loadAuthorizedProfilePrivate(profile.id),
  ]);
  const activeAccess = accessContext as
    | { tenant_id?: string; role?: string }
    | null;

  return {
    id: profile.id,
    tenantId: activeAccess?.tenant_id || profile.tenant_id,
    name: profile.full_name,
    email: profile.email,
    role: (activeAccess?.role || profile.role) as UserRole,
    avatar: profile.avatar_url ||
      `https://ui-avatars.com/api/?name=${
        encodeURIComponent(profile.full_name || "")
      }`,
    module: profile.module,
    professor_id: profile.professor_id,
    currentBookPart: profile.current_book_part,
    evaluationUnlocked: profile.evaluation_unlocked,
    hourlyRate: (myPay as any)?.hourly_rate ?? undefined,
    status_financial: privateProfile.status_financial as string | undefined,
    due_day: privateProfile.due_day as number | undefined,
    contract_accepted: profile.contract_accepted,
    accepted_at: profile.accepted_at,
    is_trainer: profile.is_trainer,
    wolfieSettings: profile.wolfie_settings || undefined,
    englishFor: profile.english_for || undefined,
    occupation: profile.occupation || undefined,
    studentCategory: profile.student_category || undefined,
    isKids: profile.is_kids === true,
    interests: Array.isArray(profile.interests)
      ? profile.interests
      : typeof profile.interests === "string" && profile.interests.trim()
      ? profile.interests.split(",").map((item: string) => item.trim()).filter(
        Boolean,
      )
      : undefined,
    preferredTopics: Array.isArray(profile.preferred_topics)
      ? profile.preferred_topics
      : undefined,
    shortTermGoal: profile.short_term_goal || undefined,
  };
}

/** Busca o perfil da sessão atual sem criar ou alterar registros. */
export async function loadAppUser(userId: string): Promise<User | null> {
  const { data: profile, error } = await supabase
    .from("profiles")
    .select(PROFILE_SAFE_COLS)
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  return profile ? mapProfileToAppUser(profile) : null;
}
