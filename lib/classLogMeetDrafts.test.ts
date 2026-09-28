import { expect, it, vi } from 'vitest';
vi.mock('./supabase', () => ({ supabase: { rpc: vi.fn() } }));
import { meetSuggestionFields } from './classLogMeetDrafts';
it('maps only the pedagogical fields without inventing absence of difficulties/homework', () => {
  expect(meetSuggestionFields({ lesson_objective: ' Objetivo ', content_practiced: ['Tema', null, 'Livro 2'], recurring_errors: [], homework_assigned: null, recommended_next_step: 'Continuar', narrative: 'Ignored' })).toEqual({
    lessonObjective: 'Objetivo', lastApplied: 'Tema\nLivro 2', studentDifficulties: '', homeworkAssigned: '', recommendedNextStep: 'Continuar',
  });
});
