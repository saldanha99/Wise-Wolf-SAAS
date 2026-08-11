import React, { useState } from 'react';
import { CheckCircle2, Clipboard, Loader2, MessageCircle, QrCode, Send, TriangleAlert } from 'lucide-react';
import { asaasService, type ManualPixResult } from '../services/asaasService';

interface Props {
  studentId: string;
  onGenerated?: () => void;
}

const money = (value: number) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
}).format(value);

const date = (value: string) => {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
};

const StudentManualPixManager: React.FC<Props> = ({ studentId, onGenerated }) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ManualPixResult | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    if (!window.confirm(
      'Gerar o Pix vinculado deste aluno e enviá-lo automaticamente pelo WhatsApp da direção?',
    )) return;

    setLoading(true);
    setError('');
    setCopied(false);
    try {
      const generated = await asaasService.generateStudentManualPix(studentId);
      setResult(generated);
      onGenerated?.();
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : 'Não foi possível gerar o Pix manual.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!result?.pixPayload) return;
    try {
      await navigator.clipboard.writeText(result.pixPayload);
    } catch {
      const field = document.createElement('textarea');
      field.value = result.pixPayload;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  };

  return (
    <section className="rounded-2xl border border-cyan-200 bg-cyan-50/80 p-4 dark:border-cyan-800/60 dark:bg-cyan-950/25">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-100 text-cyan-700 dark:bg-cyan-900/60 dark:text-cyan-200">
            <QrCode size={20} />
          </div>
          <div>
            <h4 className="text-sm font-black text-cyan-950 dark:text-cyan-100">Pix manual vinculado</h4>
            <p className="mt-1 max-w-xl text-xs font-medium leading-relaxed text-cyan-800 dark:text-cyan-200">
              Reaproveita a cobrança aberta ou cria uma nova no Asaas já ligada ao aluno. O código é enviado no privado pela instância da direção e entra no rateio quando for pago.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={loading}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-cyan-700 px-4 py-3 text-xs font-black uppercase tracking-wider text-white shadow-sm transition-colors hover:bg-cyan-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-cyan-500 dark:text-slate-950 dark:hover:bg-cyan-400"
        >
          {loading ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
          {loading ? 'Gerando e enviando...' : 'Gerar e enviar Pix'}
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-red-100 px-4 py-3 text-xs font-bold text-red-900 dark:bg-red-950/60 dark:text-red-200">
          <TriangleAlert className="mt-0.5 shrink-0" size={15} /> {error}
        </div>
      )}

      {result && (
        <div className="mt-4 space-y-3 rounded-xl border border-cyan-200 bg-white p-4 dark:border-cyan-800 dark:bg-slate-950">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-black text-slate-950 dark:text-white">
                {money(result.value)} · vence {date(result.dueDate)}
              </p>
              <p className="mt-0.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                {result.reused ? 'Cobrança aberta reaproveitada, sem duplicar.' : 'Nova cobrança individual criada e vinculada.'}
              </p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[10px] font-black uppercase tracking-wider ${result.whatsappSent ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100'}`}>
              {result.whatsappSent ? <CheckCircle2 size={13} /> : <MessageCircle size={13} />}
              {result.whatsappSent
                ? 'Enviado pela direção'
                : result.whatsappSuppressed
                  ? 'Teste: envio bloqueado'
                  : 'Copie e envie manualmente'}
            </span>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[10px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-300">Código Pix copia e cola</span>
            <textarea
              readOnly
              value={result.pixPayload}
              rows={4}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full resize-none rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 font-mono text-xs font-semibold text-slate-950 outline-none focus:ring-2 focus:ring-cyan-500 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />
          </label>
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-300 bg-cyan-100 px-4 py-3 text-xs font-black uppercase tracking-wider text-cyan-950 transition-colors hover:bg-cyan-200 dark:border-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-100 dark:hover:bg-cyan-900"
          >
            {copied ? <CheckCircle2 size={16} /> : <Clipboard size={16} />}
            {copied ? 'Código copiado' : 'Copiar código Pix'}
          </button>
        </div>
      )}
    </section>
  );
};

export default StudentManualPixManager;
