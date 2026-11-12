import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

/**
 * Liga/desliga o pop-up "Sugestão de plano" (o "Não mostrar mais" grava aqui).
 * Some enquanto não sabe o estado — melhor não mostrar do que mostrar errado.
 */
export default function PlanSuggestionToggle({ userId }: { userId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from('teacher_lesson_plan_prompt_prefs')
        .select('disabled')
        .eq('user_id', userId)
        .maybeSingle();
      if (active && !error) setEnabled(!(data as { disabled?: boolean } | null)?.disabled);
    })();
    return () => { active = false; };
  }, [userId]);

  if (enabled === null) return null;

  const toggle = async () => {
    setSaving(true);
    const next = !enabled;
    const { error } = await supabase
      .from('teacher_lesson_plan_prompt_prefs')
      .upsert({ user_id: userId, disabled: !next, updated_at: new Date().toISOString() });
    if (!error) setEnabled(next);
    setSaving(false);
  };

  return (
    <label data-tour="plan-suggestion-toggle" className="flex items-center gap-2 text-xs font-bold text-brand-muted cursor-pointer select-none">
      <input type="checkbox" checked={enabled} disabled={saving} onChange={() => { void toggle(); }} className="h-4 w-4 accent-[var(--brand-accent,#4f46e5)]" />
      Sugerir o plano antes de cada aula
    </label>
  );
}
