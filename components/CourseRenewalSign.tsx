import React, { useEffect, useState } from 'react';
import { AlertCircle, CalendarDays, CheckCircle2, Loader2, Lock } from 'lucide-react';
import { supabase } from '../lib/supabase';

type RenewalSchedule = { teacher_first_name: string; slots: { day: string; time: string }[] };
type Renewal = {
  student_name: string; school_name: string; term_months: number;
  monthly_fee_cents: number; classes_per_week: number; contract_start: string;
  first_due_date: string; last_due_date: string; service_end_date: string;
  status: 'PENDING_SIGNATURE' | 'SIGNED'; billing_status: string; expired: boolean;
  // Horário que o aluno assina junto (renovação com novas condições). Ausente = mantém a agenda atual.
  schedule?: RenewalSchedule | null;
  // Marca da escola (tenants.branding). Valor inválido é ignorado: a página cai no visual padrão.
  school_logo_url?: string | null;
  brand_primary?: string | null;
  brand_secondary?: string | null;
};

const DISPLAY = "'Manrope', 'DM Sans', system-ui, sans-serif";
const BODY = "'DM Sans', 'Inter', system-ui, sans-serif";
const DEFAULT_PRIMARY = '#06142d';
const DEFAULT_SECONDARY = '#320606';

const date = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');
const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hexColor = (value: unknown) => (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null);
const httpsUrl = (value: unknown) => (typeof value === 'string' && /^https:\/\/[^\s"<>]+$/.test(value) ? value : null);

function parseSchedule(value: unknown): RenewalSchedule | null {
  if (value === null || value === undefined) return null;
  const s = value as Partial<RenewalSchedule>;
  if (typeof s !== 'object' || typeof s.teacher_first_name !== 'string' || !Array.isArray(s.slots) || s.slots.length < 1
    || s.slots.some(slot => !slot || typeof slot.day !== 'string' || typeof slot.time !== 'string' || !/^\d{2}:\d{2}$/.test(slot.time))) {
    throw new Error('invalid_renewal');
  }
  return { teacher_first_name: s.teacher_first_name, slots: s.slots.map(slot => ({ day: slot.day, time: slot.time })) };
}

function parse(value: unknown): Renewal {
  const v = value as Partial<Renewal> | null;
  if (!v || typeof v.student_name !== 'string' || typeof v.school_name !== 'string' || v.term_months !== 6
    || !Number.isSafeInteger(v.monthly_fee_cents) || Number(v.monthly_fee_cents) <= 0
    || !Number.isInteger(v.classes_per_week) || Number(v.classes_per_week) < 1 || Number(v.classes_per_week) > 7
    || !['PENDING_SIGNATURE', 'SIGNED'].includes(String(v.status))
    || [v.contract_start, v.first_due_date, v.last_due_date, v.service_end_date].some(x => typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x))) {
    throw new Error('invalid_renewal');
  }
  return {
    ...(v as Renewal),
    schedule: parseSchedule(v.schedule),
    school_logo_url: httpsUrl(v.school_logo_url),
    brand_primary: hexColor(v.brand_primary),
    brand_secondary: hexColor(v.brand_secondary),
  };
}

/** Moldura da página: faixa na cor da escola, logo e a folha branca por cima. */
function BrandShell({ data, children }: { data: Renewal | null; children: React.ReactNode }) {
  const primary = data?.brand_primary || DEFAULT_PRIMARY;
  const secondary = data?.brand_secondary || DEFAULT_SECONDARY;
  const school = data?.school_name || '';
  return (
    <main className="min-h-screen bg-[#f3f4f7] text-slate-700" style={{ fontFamily: BODY }}>
      <div
        className="relative overflow-hidden"
        style={{ background: `radial-gradient(110% 85% at 88% -10%, ${secondary} 0%, transparent 62%), radial-gradient(70% 60% at 0% 110%, rgba(255,255,255,0.08) 0%, transparent 70%), ${primary}` }}
      >
        <div className="mx-auto flex max-w-xl flex-col items-center px-5 pb-28 pt-10 text-center text-white">
          {data?.school_logo_url ? (
            <img
              src={data.school_logo_url}
              alt={school}
              className="h-[72px] w-[72px] rounded-[22px] bg-white object-contain p-2.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,0.6)]"
            />
          ) : (
            <div className="grid h-[72px] w-[72px] place-items-center rounded-[22px] bg-white/10 text-2xl font-extrabold ring-1 ring-white/20" style={{ fontFamily: DISPLAY }} aria-hidden="true">
              {school.slice(0, 1) || '•'}
            </div>
          )}
          {school && <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.24em] text-white/60">{school}</p>}
          <h1 className="mt-2 text-[28px] font-extrabold leading-tight tracking-tight" style={{ fontFamily: DISPLAY }}>Renovação do curso</h1>
        </div>
      </div>
      <div className="mx-auto -mt-20 max-w-xl px-4 pb-12">{children}</div>
    </main>
  );
}

const sheet = 'rounded-[28px] bg-white p-6 shadow-[0_28px_70px_-34px_rgba(6,20,45,0.55)] ring-1 ring-slate-900/5 sm:p-8';
const eyebrow = 'text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400';

export default function CourseRenewalSign() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [data, setData] = useState<Renewal | null>(null);
  const [loading, setLoading] = useState(true);
  const [signature, setSignature] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [signing, setSigning] = useState(false);
  useEffect(() => { void (async () => {
    if (!/^[a-f0-9]{64}$/.test(token)) { setError('Link inválido.'); setLoading(false); return; }
    const response = await supabase.rpc('get_student_course_renewal_public', { p_token: token });
    try {
      if (response.error || !response.data?.ok) throw new Error(response.data?.error || 'Não foi possível abrir o contrato.');
      setData(parse(response.data.data));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setError(message === 'invalid_renewal' ? 'Não foi possível abrir o contrato.' : (message || 'Não foi possível abrir o contrato.'));
    }
    setLoading(false);
  })(); }, [token]);
  const sign = async () => {
    setSigning(true); setError('');
    const response = await supabase.rpc('sign_student_course_renewal', { p_token: token, p_typed_signature: signature });
    setSigning(false);
    if (response.error || !response.data?.ok) { setError(response.data?.error || 'Não foi possível assinar.'); return; }
    setData(current => current ? { ...current, status: 'SIGNED', billing_status: String(response.data.billing_status || current.billing_status) } : current);
  };

  if (loading) {
    return (
      <BrandShell data={null}>
        <div className={`${sheet} grid place-items-center py-16`}>
          <Loader2 className="animate-spin text-slate-400" size={34} aria-label="Carregando" />
        </div>
      </BrandShell>
    );
  }
  if (!data) {
    return (
      <BrandShell data={null}>
        <div role="alert" className={`${sheet} text-center`}>
          <AlertCircle className="mx-auto mb-3 text-rose-500" size={40} />
          <h2 className="text-xl font-extrabold text-slate-900" style={{ fontFamily: DISPLAY }}>Não foi possível abrir</h2>
          <p className="mt-2 text-sm text-slate-500">{error}</p>
        </div>
      </BrandShell>
    );
  }

  const primary = data.brand_primary || DEFAULT_PRIMARY;
  if (data.status === 'SIGNED') {
    return (
      <BrandShell data={data}>
        <section className={`${sheet} text-center`}>
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full" style={{ background: `${primary}14` }}>
            <CheckCircle2 size={34} style={{ color: primary }} />
          </div>
          <h2 className="mt-4 text-2xl font-extrabold text-slate-900" style={{ fontFamily: DISPLAY }}>Renovação assinada</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500">Recebemos sua assinatura. A situação da cobrança será processada e registrada pela escola.</p>
        </section>
      </BrandShell>
    );
  }

  const schedule = data.schedule;
  return (
    <BrandShell data={data}>
      <section className={sheet}>
        <p className="text-sm text-slate-500">Olá, <b className="font-semibold text-slate-900">{data.student_name}</b>. Confira as condições aprovadas:</p>

        <div className="mt-6 flex items-end justify-between gap-4 border-b border-slate-100 pb-6">
          <div>
            <p className={eyebrow}>Mensalidade</p>
            <p className="mt-1 text-[40px] font-extrabold leading-none tracking-tight text-slate-900" style={{ fontFamily: DISPLAY }}>{money(data.monthly_fee_cents)}</p>
            <p className="mt-2 text-xs text-slate-500">por mês · 6 parcelas</p>
          </div>
          <span className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-white" style={{ background: primary }}>6 meses</span>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5">
          <div>
            <dt className={eyebrow}>Frequência</dt>
            <dd className="mt-1 text-base font-bold text-slate-900">{data.classes_per_week}x por semana</dd>
          </div>
          <div>
            <dt className={eyebrow}>Vigência</dt>
            <dd className="mt-1 text-base font-bold text-slate-900">{date(data.contract_start)} a {date(data.service_end_date)}</dd>
          </div>
        </dl>

        {schedule && (
          <div className="mt-6 rounded-2xl p-4" style={{ background: `${primary}0d` }}>
            <p className={eyebrow}>Horário das aulas</p>
            <p className="mt-2 text-base font-bold text-slate-900">{schedule.slots.map(slot => `${slot.day} às ${slot.time}`).join(' · ')}</p>
            <p className="mt-1 text-sm text-slate-500">com a teacher {schedule.teacher_first_name}</p>
          </div>
        )}

        <div className="mt-6 flex gap-3 text-sm text-slate-600">
          <CalendarDays size={18} className="mt-0.5 shrink-0 text-slate-400" />
          <p>São 6 parcelas mensais, da competência de {date(data.first_due_date)} até {date(data.last_due_date)}. A última parcela mantém as aulas até {date(data.service_end_date)}.</p>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-slate-400">Esta renovação prorroga o contrato anterior. As demais cláusulas continuam válidas; somente vigência, parcelas, valor{schedule ? ', frequência e horário ficam confirmados' : ' e frequência ficam confirmados'} conforme o resumo acima.</p>

        {data.expired ? (
          <div role="alert" className="mt-6 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">Este link expirou. Peça um novo à escola.</div>
        ) : (
          <div className="mt-7 space-y-5 border-t border-slate-100 pt-6">
            <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-600">
              <input id="renewal-consent" type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300" style={{ accentColor: primary }} />
              Li e concordo com as condições desta renovação.
            </label>
            <div>
              <label htmlFor="renewal-signature" className={eyebrow}>Assine digitando seu nome completo</label>
              <input
                id="renewal-signature"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-lg text-slate-900 outline-none transition focus:border-transparent focus:bg-white focus:ring-2"
                style={{ fontFamily: DISPLAY, ['--tw-ring-color' as string]: primary }}
                value={signature}
                onChange={e => setSignature(e.target.value)}
                placeholder={data.student_name}
                autoComplete="name"
              />
            </div>
            {error && <p role="alert" className="text-xs font-semibold text-rose-600">{error}</p>}
            <button
              type="button"
              onClick={sign}
              disabled={signing || !accepted || signature.trim().length < 3}
              className="flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-sm font-extrabold uppercase tracking-[0.12em] text-white shadow-[0_16px_34px_-16px_rgba(6,20,45,0.8)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: primary, outlineColor: primary, fontFamily: DISPLAY }}
            >
              {signing && <Loader2 size={16} className="animate-spin" />}Assinar renovação
            </button>
            <p className="flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
              <Lock size={12} /> Registramos data, hora e endereço de rede para a trilha de auditoria.
            </p>
          </div>
        )}
      </section>
    </BrandShell>
  );
}
