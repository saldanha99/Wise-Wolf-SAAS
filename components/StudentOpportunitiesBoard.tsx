import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { GraduationCap, Check, Loader2, CalendarClock } from 'lucide-react';
import { dayMonth, slotsText, type MyDepartureOffer } from '../lib/teacherDeparture';

// ─────────────────────────────────────────────────────────────────────────────
// ALUNOS DISPONÍVEIS — quando um professor sai, os alunos dele aparecem aqui
// para quem já tem TODOS os horários do aluno livres (conferido no servidor).
// O primeiro que aceitar fica com o aluno, sem aula experimental: a troca usa a
// transferência oficial (histórico preservado; termo do aluno quando a escola
// exige). Antes do aceite só aparecem primeiro nome + inicial e os horários.
// Renderiza null quando não há aluno disponível.
// ─────────────────────────────────────────────────────────────────────────────

const ERRORS: Record<string, string> = {
  aluno_ja_atribuido: 'Outro professor aceitou este aluno primeiro.',
  horario_indisponivel: 'Algum horário deste aluno não está mais livre na sua agenda.',
  saida_encerrada: 'A escola já resolveu este aluno.',
  aluno_mudou_de_professor: 'A escola já resolveu este aluno.',
  escola_sem_direcao_ativa: 'Não foi possível concluir agora. Avise a coordenação.',
};

const StudentOpportunitiesBoard: React.FC<{ userId: string }> = ({ userId }) => {
  const [offers, setOffers] = useState<MyDepartureOffer[]>([]);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_departure_offers');
    if (error) { console.warn('alunos disponíveis:', error.message); return; }
    setOffers((data as MyDepartureOffer[] | null) ?? []);
  }, []);

  useEffect(() => { void load(); }, [load, userId]);

  const claim = async (offer: MyDepartureOffer) => {
    if (!window.confirm(`Ficar com ${offer.student_label} (${slotsText(offer.slots)}) a partir de ${dayMonth(offer.starts_on)}? Os horários entram na sua agenda.`)) return;
    setClaiming(offer.offer_id);
    setMsg(null);
    try {
      const { data, error } = await supabase.rpc('claim_departure_offer', { p_offer: offer.offer_id });
      if (error) throw error;
      if (data?.ok) {
        setMsg({ ok: true, text: data.pending_terms
          ? `Aluno reservado para você. A escola manda o termo do aluno para você assinar pelo WhatsApp; assinado, a troca vale a partir de ${dayMonth(data.cutover_date)}.`
          : `Aluno seu a partir de ${dayMonth(data.cutover_date)}. A família já foi avisada.` });
      } else {
        setMsg({ ok: false, text: ERRORS[String(data?.error)] ?? 'Não foi possível aceitar agora.' });
      }
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as { message?: string })?.message || 'Não foi possível aceitar agora.' });
    }
    setClaiming(null);
  };

  if (offers.length === 0 && !msg) return null;

  return (
    <div className="mb-6 bg-brand-surface rounded-3xl border border-brand-border p-5" data-tour="departure-offers">
      <div className="flex items-center gap-2 mb-1">
        <GraduationCap size={18} className="text-brand-accent" />
        <h3 className="text-sm font-black text-brand-text">Alunos disponíveis</h3>
      </div>
      <p className="text-xs text-brand-muted mb-4">Alunos trocando de professor com horários que já cabem inteiros na sua agenda. Quem aceitar primeiro fica com o aluno, sem aula experimental: a primeira aula é para vocês se conhecerem.</p>
      {msg && <p className={`text-xs font-bold mb-3 ${msg.ok ? 'text-emerald-600' : 'text-amber-600'}`}>{msg.text}</p>}
      <div className="space-y-2">
        {offers.map(o => (
          <div key={o.offer_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-2xl bg-brand-surface-2/50 border border-brand-border p-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-brand-text">{o.student_label}</p>
              <p className="text-xs text-brand-muted flex items-center gap-1"><CalendarClock size={12} />{slotsText(o.slots)} · a partir de {dayMonth(o.starts_on)}</p>
            </div>
            <button onClick={() => claim(o)} disabled={claiming !== null}
              className="shrink-0 px-4 py-2 rounded-xl bg-brand-accent text-white text-xs font-black flex items-center justify-center gap-1 disabled:opacity-50">
              {claiming === o.offer_id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Quero este aluno
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StudentOpportunitiesBoard;
