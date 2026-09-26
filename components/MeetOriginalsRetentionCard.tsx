import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { originalsErrorText, readOriginalsStatus, type MeetOriginalsStatus } from '../lib/meetOriginals';

const day = (value: string | null) => value
  ? new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  : '';

// Originais das aulas no Drive da conta central (direção, "Conta central Google"):
// transcrição, anotações do Gemini e planilha de presença vão para a LIXEIRA do
// Drive 90 dias depois da aula (decisão da direção, 26/09/2026). O servidor só
// move arquivo com id vindo da Meet API ou da planilha guardada, e conta por
// arquivo o que aconteceu.
export default function MeetOriginalsRetentionCard({ deleteEnabled, deleteGranted }: { deleteEnabled: boolean; deleteGranted: boolean }) {
  const [status, setStatus] = useState<MeetOriginalsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: rpcError } = await supabase.rpc('get_meet_originals_retention_status');
    const parsed = rpcError ? null : readOriginalsStatus(data);
    if (!parsed) setError('Não foi possível ler a situação dos originais no Drive.');
    setStatus(parsed);
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <section data-tour="meet-originals-retention" className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface p-5">
    <div className="flex items-center gap-2"><Trash2 size={18} className="text-slate-600"/><h3 className="font-bold text-brand-text">Originais no Google Drive da escola</h3></div>
    <p className="text-sm text-brand-muted">O documento da transcrição, o das anotações do Gemini e a planilha de presença de cada aula ficam no Drive da conta central. Com a lixeira automática ligada, {status?.trash_after_days || 90} dias depois da aula eles vão para a <strong>lixeira</strong> do Drive (onde ainda ficam 30 dias, recuperáveis). Só vão para a lixeira os arquivos que o próprio Meet indicou e as planilhas que o sistema identificou pelo código da sala — nada é procurado por nome. As cópias no sistema seguem o mesmo prazo.</p>
    {!deleteEnabled && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">A lixeira automática ainda não foi ligada nesta instalação (pedido à administração técnica). Enquanto isso, os originais ficam no Drive e os prazos continuam sendo contados; o sistema já confere no Meet quais são os documentos de cada aula (o Google só informa isso até 28 dias depois da aula), para a lixeira alcançá-los quando for ligada.</p>}
    {deleteEnabled && !deleteGranted && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Para mover os originais para a lixeira, a conta central precisa de uma permissão nova do Drive: use <strong>Reconectar conta central</strong> (entre com a mesma conta).</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {loading && !status && <p className="flex items-center gap-2 text-sm text-brand-muted"><Loader2 size={14} className="animate-spin"/>Lendo a situação dos originais…</p>}
    {status && <>
      <ul className="grid gap-2 text-sm text-brand-text sm:grid-cols-2">
        <li><strong>{status.trashed}</strong> na lixeira{status.last_trashed_at ? ` (último em ${day(status.last_trashed_at)})` : ''}</li>
        <li><strong>{status.waiting}</strong> aguardando o prazo{status.next_due_at ? ` (próximo em ${day(status.next_due_at)})` : ''}</li>
        <li><strong>{status.due}</strong> com o prazo vencido, na fila</li>
        <li><strong>{status.gone}</strong> que já não estavam no Drive</li>
      </ul>
      {status.failing > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-testid="originals-failing">{status.failing} {status.failing === 1 ? 'arquivo não foi movido' : 'arquivos não foram movidos'} ainda: {originalsErrorText(status.last_error_code)}. O sistema tenta de novo sozinho.</p>}
      {status.other_account > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{status.other_account} {status.other_account === 1 ? 'original é' : 'originais são'} da conta central anterior: só ela consegue movê-los. Apague pelo Drive dessa conta ou reconecte-a.</p>}
      {status.refused > 0 && <p className="text-sm text-brand-muted">{status.refused} {status.refused === 1 ? 'arquivo não foi tocado' : 'arquivos não foram tocados'} por não ser da conta central ou não ser do tipo esperado.</p>}
      {status.attendance_unidentified > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-testid="originals-attendance-unidentified">{status.attendance_unidentified} {status.attendance_unidentified === 1 ? 'planilha de presença foi escolhida' : 'planilhas de presença foram escolhidas'} sem o código da sala no nome (pelo e-mail do professor): pode não ser da aula, então não vai para a lixeira sozinha. Confira no Drive da conta central e, se for mesmo da aula, apague à mão.</p>}
      {status.erasures > 0 && <p className="text-sm text-brand-muted">{status.erasures} {status.erasures === 1 ? 'pedido de exclusão atendido' : 'pedidos de exclusão atendidos'}{status.last_erasure_at ? ` (último em ${day(status.last_erasure_at)})` : ''}. O pedido é feito na ficha do aluno → Continuidade pedagógica.</p>}
    </>}
  </section>;
}
