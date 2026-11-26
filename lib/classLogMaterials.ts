import { supabase } from './supabase';
import { googleMeetAction } from './googleMeet';
import type { ClassLogResult } from './classLogRules';

// Material e parte do livro de cada aula (tabela class_log_materials, só por RPC).
// O último material do aluno volta no lançamento seguinte, no dossiê e no aviso
// ao professor novo de uma troca.

export interface MaterialOption { id: string; label: string; collection: string | null; part: number | null; title: string }
export interface LastMaterial {
  materialId: string | null; title: string | null; collection: string | null; part: number | null;
  reference: string | null; label: string | null; classDate: string | null; teacherName: string | null;
}
export interface ClassLogMaterialDraft { materialId: string; materialTitle: string; materialRef: string; fromMeet?: boolean }

export function materialOptionLabel(title: string, collection: string | null, part: number | null): string {
  if (collection && part != null) return `${collection} · Part ${part}`;
  if (collection) return `${collection} · ${title}`;
  return title;
}

/** Materiais aprovados da escola para escolher no lançamento (livro + parte primeiro). */
export async function loadMaterialCatalog(): Promise<MaterialOption[]> {
  const [{ data: materials, error }, { data: collections }] = await Promise.all([
    supabase.from('pedagogical_materials').select('id,title,collection_id,part_number').eq('approval_status', 'APPROVED').limit(1000),
    supabase.from('pedagogical_collections').select('id,title').limit(500),
  ]);
  if (error) return [];
  const names = new Map((collections || []).map((c: { id: string; title: string }) => [c.id, c.title]));
  return (materials || []).map((m: { id: string; title: string; collection_id: string | null; part_number: number | null }) => {
    const collection = m.collection_id ? names.get(m.collection_id) || null : null;
    return { id: m.id, title: m.title, collection, part: m.part_number, label: materialOptionLabel(m.title, collection, m.part_number) };
  }).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { numeric: true }));
}

export async function loadLastMaterials(studentIds: string[]): Promise<Record<string, LastMaterial>> {
  const ids = [...new Set(studentIds.filter(Boolean))].slice(0, 200);
  if (!ids.length) return {};
  const { data, error } = await supabase.rpc('last_class_materials', { p_student_ids: ids });
  if (error || !data || typeof data !== 'object') return {};
  return data as Record<string, LastMaterial>;
}

/** Depois do lançamento: grava o material das aulas que entraram. Falha aqui não desfaz a aula. */
export async function saveClassLogMaterials(
  result: Pick<ClassLogResult, 'entries'>,
  drafts: Record<string, ClassLogMaterialDraft | undefined>,
): Promise<boolean> {
  const items = result.entries.flatMap(entry => {
    const draft = entry.ref ? drafts[entry.ref] : undefined;
    if (entry.status !== 'lancada' || !entry.id || !draft) return [];
    const materialId = draft.materialId.trim(), title = draft.materialTitle.trim(), reference = draft.materialRef.trim();
    if (!materialId && !title && !reference) return [];
    return [{ class_log_id: entry.id, material_id: materialId || null, title: title || null, reference: reference || null, from_meet: !!draft.fromMeet }];
  });
  if (!items.length) return true;
  const { error } = await supabase.rpc('save_class_log_materials', { p_items: items });
  return !error;
}

/** Busca a transcrição no Google agora e gera o rascunho, se ela já chegou. */
export async function requestSummaryNow(sessionId: string): Promise<'READY' | 'WAITING' | 'NOT_RECORDED' | 'FAILED'> {
  try {
    const out = await googleMeetAction<{ ok: boolean; status: string }>('summary_now', { sessionId });
    if (out.status === 'SUCCEEDED') return 'READY';
    if (out.status === 'NOT_RECORDED') return 'NOT_RECORDED';
    if (out.status === 'FAILED') return 'FAILED';
    return 'WAITING';
  } catch {
    return 'FAILED';
  }
}
