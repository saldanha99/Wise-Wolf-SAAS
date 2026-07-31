import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth, recentMonths } from '../lib/dateUtils';
import { X, Loader2, Printer } from 'lucide-react';

interface Props { teacherId: string; editable?: boolean; onClose: () => void; }

const PRESENCE_PT: Record<string, string> = {
  COMPLETED: 'Realizada', STUDENT_ABSENCE: 'Falta do aluno', TEACHER_ABSENCE: 'Falta do professor',
  EXPIRED: 'Expirada', 'Falta Justificada': 'Falta justificada', Falta: 'Falta',
};

const TeacherActivityReport: React.FC<Props> = ({ teacherId, editable = false, onClose }) => {
  const [month, setMonth] = useState<string>(localMonth());
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [notes, setNotes] = useState('');
  const [printError, setPrintError] = useState('');

  const load = async (m: string) => {
    setLoading(true);
    const { data: d } = await supabase.rpc('get_teacher_activity_report', { p_teacher_id: teacherId, p_month: m });
    setData(d?.error ? null : d);
    setNotes(d?.closing?.admin_notes || '');
    setLoading(false);
  };
  useEffect(() => { load(month); }, [month]);

  const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
  const fmt = (x?: string) => x ? new Date(x + 'T00:00:00').toLocaleDateString('pt-BR') : '—';
  const monthLabel = (m: string) => { const [y, mo] = m.split('-'); return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
  const monthOpts = recentMonths(6);
  const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character] || character));

  const generatePDF = () => {
    if (!data) return;
    setPrintError('');
    const t = data.teacher; const tot = data.totals || {};
    const rows = (data.lessons || []).map((l: any) => `<tr>
      <td>${escapeHtml(fmt(l.date))}</td><td>${escapeHtml(l.student || '—')}</td><td>${escapeHtml(PRESENCE_PT[l.presence] || l.presence)}${l.subtype ? ` · ${escapeHtml(l.subtype)}` : ''}</td>
      <td>${escapeHtml(l.content || '')}</td><td style="text-align:right">${escapeHtml(l.paid ? money(l.value) : '—')}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Relatório ${escapeHtml(t.name)} ${escapeHtml(monthLabel(month))}</title>
    <style>
      *{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a}
      body{padding:32px;max-width:800px;margin:0 auto}
      h1{font-size:20px;margin:0 0 4px} .sub{color:#64748b;font-size:13px}
      .box{border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin:16px 0}
      .grid{display:flex;gap:16px;flex-wrap:wrap} .grid div{flex:1;min-width:120px}
      .kpi{font-size:22px;font-weight:800} .lbl{font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700}
      table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px}
      th{text-align:left;background:#f1f5f9;padding:6px;font-size:10px;text-transform:uppercase;color:#475569}
      td{padding:6px;border-bottom:1px solid #eef2f7}
      .total{font-size:18px;font-weight:800;color:#059669}
      .notes{white-space:pre-wrap;font-size:12px;color:#334155}
      @media print{body{padding:0}}
    </style></head><body>
      <h1>Relatório de Atividades — ${escapeHtml(t.name)}</h1>
      <div class="sub">${escapeHtml(data.school || 'Escola')} · Competência: <b>${escapeHtml(monthLabel(month))}</b></div>
      <div class="box grid">
        <div><div class="lbl">Aulas realizadas</div><div class="kpi">${tot.completed || 0}</div></div>
        <div><div class="lbl">Faltas do aluno</div><div class="kpi">${tot.student_absences || 0}</div></div>
        <div><div class="lbl">Faltas do prof.</div><div class="kpi">${tot.teacher_absences || 0}</div></div>
        <div><div class="lbl">Aulas pagas</div><div class="kpi">${tot.paid_lessons || 0}</div></div>
        <div><div class="lbl">Total a receber</div><div class="total">${money(tot.amount)}</div></div>
      </div>
      <table><thead><tr><th>Data</th><th>Aluno</th><th>Status</th><th>Conteúdo</th><th style="text-align:right">Valor</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">Sem aulas no período</td></tr>'}</tbody></table>
      ${notes ? `<div class="box"><div class="lbl">Observações</div><div class="notes">${escapeHtml(notes)}</div></div>` : ''}
      <div class="box"><div class="lbl">Pagamento</div><div class="sub">Valor/aula: ${escapeHtml(money(t.hourly_rate))} · PIX: ${escapeHtml(t.pix || '—')}</div></div>
      <p style="font-size:10px;color:#94a3b8;margin-top:24px">Gerado por Wise Wolf em ${escapeHtml(new Date().toLocaleString('pt-BR'))}</p>
    </body></html>`;

    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'Impressão do relatório do professor');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.border = '0';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    document.body.appendChild(frame);

    const printWindow = frame.contentWindow;
    const printDocument = frame.contentDocument;
    if (!printWindow || !printDocument) {
      frame.remove();
      setPrintError('Não foi possível preparar o relatório. Tente novamente.');
      return;
    }

    let cleanupTimer: number | undefined;
    const cleanup = () => {
      if (cleanupTimer) window.clearTimeout(cleanupTimer);
      printWindow.onafterprint = null;
      frame.remove();
    };

    printWindow.onafterprint = cleanup;
    printDocument.open();
    printDocument.write(html);
    printDocument.close();

    window.setTimeout(() => {
      try {
        printWindow.focus();
        cleanupTimer = window.setTimeout(cleanup, 60_000);
        printWindow.print();
      } catch {
        cleanup();
        setPrintError('Não foi possível abrir a impressão. Verifique as permissões do navegador.');
      }
    }, 100);
  };

  const saveNotes = async () => {
    // persiste observações no fechamento do mês (cria se não existir)
    await supabase.from('teacher_closings').upsert({
      teacher_id: teacherId, month_year: month, admin_notes: notes, tenant_id: (data?.teacher as any)?.tenant_id,
    }, { onConflict: 'teacher_id,month_year' }).then(() => {}, () => {});
  };

  const t = data?.teacher; const tot = data?.totals || {};

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-brand-surface w-full max-w-2xl rounded-3xl border border-brand-border shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-brand-border flex items-center gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-brand-text">Relatório / Folha do Professor</h2>
            <p className="text-xs text-brand-muted">{t?.name || '—'}</p>
          </div>
          <select value={month} onChange={e => setMonth(e.target.value)} className="ml-auto text-sm font-bold bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border">
            {monthOpts.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-brand-surface-2 text-brand-muted"><X size={18} /></button>
        </div>

        {loading ? <div className="p-12 text-center"><Loader2 className="animate-spin mx-auto text-brand-accent" size={28} /></div>
        : !data ? <div className="p-10 text-center text-brand-muted">Sem acesso ou dados.</div>
        : (
          <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Stat label="Realizadas" value={`${tot.completed || 0}`} />
              <Stat label="Faltas aluno" value={`${tot.student_absences || 0}`} />
              <Stat label="Aulas pagas" value={`${tot.paid_lessons || 0}`} />
              <Stat label="A receber" value={money(tot.amount)} accent="text-emerald-600" />
            </div>
            <div className="border border-brand-border rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-brand-surface-2 text-brand-muted"><tr><th className="p-2 text-left">Data</th><th className="p-2 text-left">Aluno</th><th className="p-2 text-left">Status</th><th className="p-2 text-right">Valor</th></tr></thead>
                <tbody>
                  {(data.lessons || []).length === 0 ? <tr><td colSpan={4} className="p-4 text-center text-brand-muted">Sem aulas no período</td></tr>
                    : (data.lessons || []).map((l: any, i: number) => (
                      <tr key={i} className="border-t border-brand-border">
                        <td className="p-2">{fmt(l.date)}</td>
                        <td className="p-2 truncate max-w-[120px]">{l.student || '—'}</td>
                        <td className="p-2">{PRESENCE_PT[l.presence] || l.presence}</td>
                        <td className="p-2 text-right">{l.paid ? money(l.value) : '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {editable ? (
              <div>
                <label className="text-xs font-bold text-brand-text">Observações (entram no PDF)</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={saveNotes} rows={3}
                  className="w-full mt-1 p-3 rounded-xl border border-brand-border bg-brand-surface text-brand-text text-sm resize-none" placeholder="Ex: bônus, ajustes, recados ao professor..." />
              </div>
            ) : notes ? <div className="bg-brand-surface-2/50 rounded-xl p-3 text-xs text-brand-muted whitespace-pre-wrap"><b>Observações:</b> {notes}</div> : null}
            <button onClick={generatePDF} className="w-full py-3 bg-tenant-primary text-white rounded-xl font-black uppercase tracking-widest flex items-center justify-center gap-2">
              <Printer size={16} /> Gerar PDF {editable ? '(para enviar)' : ''}
            </button>
            {printError && <p role="alert" className="text-center text-xs font-bold text-red-600">{printError}</p>}
          </div>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div className="bg-brand-surface-2/50 border border-brand-border rounded-xl p-2.5">
    <p className="text-[9px] font-black text-brand-muted uppercase">{label}</p>
    <p className={`text-base font-black ${accent || 'text-brand-text'}`}>{value}</p>
  </div>
);

export default TeacherActivityReport;
