import { supabase } from './supabase';
import type { ClassLogItem, ClassLogDraft } from '../components/ClassLogForm';
export interface ClassLogMeetSuggestion {
  sessionId: string; summaryId: string; status: 'PROPOSED' | 'VERIFIED';
  fields: Partial<ClassLogDraft>; uncertainties: string[];
}
const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 4000) : '';
const list = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map(text).filter(Boolean) : [];
export function meetSuggestionFields(content: Record<string, unknown>): Partial<ClassLogDraft> {
  return {
    lessonObjective: text(content.lesson_objective),
    lastApplied: list(content.content_practiced).join('\n').slice(0,4000),
    studentDifficulties: list(content.recurring_errors).join('\n').slice(0,4000),
    homeworkAssigned: text(content.homework_assigned),
    recommendedNextStep: text(content.recommended_next_step),
  };
}
export async function loadClassLogMeetDrafts(items: ClassLogItem[]): Promise<Record<string, ClassLogMeetSuggestion>> {
  const entries = items.filter(item => item.classDate && item.sourceId && item.sourceType).map(item => ({
    ref: String(item.id), class_date: item.classDate, source_type: item.sourceType, source_id: item.sourceId,
  }));
  const result: Record<string, ClassLogMeetSuggestion> = {};
  for (let i=0;i<entries.length;i+=100) {
    const { data, error } = await supabase.rpc('get_class_log_meet_drafts', { p_entries: entries.slice(i,i+100) });
    if (error) throw new Error('Não foi possível buscar o resumo da reunião. Você pode preencher manualmente ou tentar novamente.');
    for (const [ref, row] of Object.entries(data || {}) as [string, any][]) {
      if (row.status !== 'PROPOSED' && row.status !== 'VERIFIED') continue;
      result[ref] = { sessionId: row.sessionId, summaryId: row.summaryId, status: row.status,
        fields: meetSuggestionFields(row.content || {}), uncertainties: list(row.content?.uncertainties) };
    }
  }
  return result;
}
