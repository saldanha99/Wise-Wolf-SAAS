import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, MessageCircle, ShieldCheck, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  asAuthorizationMode,
  asDecision,
  asGuardianReason,
  asNotEffectiveReason,
  asTermSchoolIdentity,
  CODE_FUNCTION,
  CODE_LENGTH,
  codeErrorMessage,
  consentErrorMessage,
  DECISION_LABEL,
  fillTermMarkers,
  guardianReasonText,
  isFullName,
  isObjection,
  isSixDigitCode,
  normalizeSignerName,
  notEffectiveText,
  onlyDigits,
  TERM_CHANGED_ERROR,
  termChangedNotice,
  type RecordingDecision,
} from '../lib/lessonRecordingConsent';

// Página pública do termo de registro das aulas (aluno ou responsável, sem
// login). Fica no SPA, como a troca de plano e a confirmação de presença.
// Desde 26/09/2026 a decisão só é gravada com o código de 6 dígitos mandado
// pelo WhatsApp da escola ao telefone cadastrado (migration 20260926200000).
// Desde 27/09/2026 (migration 20260927100000) o texto identifica a escola por
// marcadores que o servidor já devolve preenchidos com os dados da própria
// escola (a página só completa, se ainda sobrar algum), e o aceite de uma
// versão anterior do termo não vale: a página diz que o termo mudou e pede a
// resposta de novo. A decisão manda a versão exibida; se a escola publicou
// outra enquanto a pessoa lia, o servidor recusa (`termo_mudou`) sem gastar o
// código, e a página recarrega o texto novo para ela confirmar.
// Desde 29/09/2026 (migration 20260929100000), na escola que autoriza o
// registro por padrão a página mostra o AVISO (não um termo de aceite) e só
// grava o pedido para não registrar — com o mesmo código do WhatsApp. Nesse
// modo a escola não gera link: onde o aceite individual manda pedir "um link
// novo", a página manda falar com a escola pelo WhatsApp.

type Relation = 'SELF' | 'GUARDIAN';

interface ConsentPublic {
  found: boolean;
  expired?: boolean;
  /** Link fechado por excesso de códigos pedidos ou digitados errado. */
  blocked?: boolean;
  school_name?: string | null;
  student_first_name?: string | null;
  requires_guardian?: boolean;
  guardian_reason?: string | null;
  student_phone_masked?: string | null;
  guardian_phone_masked?: string | null;
  term_version?: string;
  term_body?: string;
  current_decision?: string;
  /** A última resposta vale para transcrever? (falso: sem código, ou do aluno quando é o responsável quem responde). */
  current_effective?: boolean;
  current_not_effective_reason?: string | null;
  /** Versão do termo da última resposta (a que a pessoa leu). */
  decided_term_version?: string | null;
  /** Valores dos marcadores {escola_nome}, {escola_documento} e {escola_contato_privacidade}. */
  school_identity?: unknown;
  /**
   * SCHOOL_DEFAULT: registro autorizado pela escola — aviso e pedido para não
   * registrar. Vem também com o link bloqueado, vencido ou revogado.
   */
  authorization_mode?: string | null;
}

interface CodeResponse {
  ok?: boolean;
  error?: string;
  sent_to?: string;
  expires_at?: string;
  retry_after_seconds?: number;
  uncertain?: boolean;
}

interface DecisionResponse {
  ok?: boolean;
  decision?: string;
  error?: string;
  attempts_left?: number;
  verified_phone?: string;
  /** Versão vigente (com `termo_mudou`) ou a gravada na decisão. */
  term_version?: string | null;
}

/** Pede o código à edge; erro HTTP volta com o corpo que ela mandou. */
async function requestCode(token: string, relation: Relation): Promise<CodeResponse> {
  const { data, error } = await supabase.functions.invoke(CODE_FUNCTION, { body: { token, relation } });
  if (!error) return (data && typeof data === 'object' ? data : { error: 'indisponivel' }) as CodeResponse;
  const context = (error as { context?: { json?: () => Promise<unknown> } }).context;
  let payload: unknown = null;
  try { payload = await context?.json?.(); } catch { payload = null; }
  return (payload && typeof payload === 'object' ? payload : { error: 'indisponivel' }) as CodeResponse;
}

export default function LessonRecordingConsentPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ConsentPublic | null>(null);
  const [relation, setRelation] = useState<Relation | ''>('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<{ relation: Relation; phone: string; uncertain: boolean } | null>(null);
  const [busy, setBusy] = useState<'' | 'code' | 'decide'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ decision: RecordingDecision; phone: string | null } | null>(null);
  const [termChanged, setTermChanged] = useState('');

  const loadPage = useCallback(async () => {
    const { data: result, error: rpcError } = await supabase.rpc('get_lesson_recording_consent_public', { p_token: token });
    if (rpcError || !result) setData({ found: false });
    else {
      setData(result as ConsentPublic);
      if ((result as ConsentPublic).requires_guardian) setRelation('GUARDIAN');
    }
  }, [token]);

  useEffect(() => {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setData({ found: false });
      setLoading(false);
      return;
    }
    void loadPage().finally(() => setLoading(false));
  }, [token, loadPage]);

  const guardianReason = asGuardianReason(data?.guardian_reason, data?.requires_guardian);
  const firstName = data?.student_first_name?.trim() || 'o aluno';
  const targetPhone = relation === 'SELF' ? data?.student_phone_masked : relation === 'GUARDIAN' ? data?.guardian_phone_masked : null;
  // Servidor que ainda não manda os telefones mascarados (a página pública foi
  // recriada por outra versão): oferece o envio assim mesmo; quem decide se há
  // telefone é o servidor, e ele devolve o número mascarado ao mandar.
  const phoneFieldKnown = !!data && (relation === 'SELF' ? 'student_phone_masked' in data : 'guardian_phone_masked' in data);
  const canSendCode = !!targetPhone || !phoneFieldKnown;
  const codeReady = !!sentTo && sentTo.relation === relation;
  const pageMode = asAuthorizationMode(data?.authorization_mode);

  function chooseRelation(value: Relation) {
    setRelation(value);
    setError('');
    // O código vale para quem ele foi mandado: trocar de papel pede outro.
    if (sentTo && sentTo.relation !== value) { setSentTo(null); setCode(''); }
  }

  async function sendCode() {
    setError('');
    if (!relation) { setError('Escolha se você é o aluno ou o responsável.'); return; }
    setBusy('code');
    const result = await requestCode(token, relation);
    setBusy('');
    if (!result.ok) {
      setError(codeErrorMessage({ error: result.error, retryAfterSeconds: result.retry_after_seconds, mode: pageMode }));
      return;
    }
    setCode('');
    setSentTo({ relation, phone: result.sent_to || targetPhone || '', uncertain: result.uncertain === true });
  }

  async function decide(accept: boolean) {
    setError('');
    setTermChanged('');
    if (!relation) { setError('Escolha se você é o aluno ou o responsável.'); return; }
    if (!isFullName(name)) { setError('Digite nome e sobrenome.'); return; }
    if (!codeReady) { setError('Peça o código pelo WhatsApp antes de responder.'); return; }
    if (!isSixDigitCode(code)) { setError('Digite os 6 números do código.'); return; }
    setBusy('decide');
    const { data: result, error: rpcError } = await supabase.rpc('decide_lesson_recording_consent_public', {
      p_token: token,
      p_signer_name: normalizeSignerName(name),
      p_relation: relation,
      p_accept: accept,
      p_code: code,
      // O aceite vale para o texto que está na tela.
      p_term_version: data?.term_version ?? null,
    });
    const response = (result || {}) as DecisionResponse;
    if (!rpcError && response.error === TERM_CHANGED_ERROR) {
      // A escola publicou outra versão enquanto a pessoa lia: mostra o texto
      // novo; o código não foi gasto e confirma de novo.
      await loadPage();
      setBusy('');
      setTermChanged(termChangedNotice(response.term_version));
      return;
    }
    setBusy('');
    if (rpcError) { setError(consentErrorMessage(rpcError.message, pageMode)); return; }
    if (!response.ok) {
      setError(codeErrorMessage({ error: response.error, attemptsLeft: response.attempts_left, mode: pageMode }));
      if (response.error === 'codigo_expirado' || response.error === 'codigo_bloqueado') setCode('');
      // A escola passou a autorizar o registro com a página aberta: mostra o
      // aviso (o código não foi gasto e serve para o pedido de não registrar).
      if (response.error === 'registro_autorizado_pela_escola') await loadPage();
      return;
    }
    setDone({ decision: asDecision(response.decision), phone: response.verified_phone || null });
  }

  if (loading) {
    return <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100">
      <Loader2 className="animate-spin text-[#002366]" size={40} />
      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Carregando…</p>
    </div>;
  }

  if (!data?.found) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-xl">
        <AlertCircle size={44} className="mx-auto mb-4 text-amber-500" />
        <h1 className="mb-2 text-lg font-black text-slate-800">{data?.blocked ? 'Link bloqueado' : 'Link indisponível'}</h1>
        <p className="text-sm text-slate-500">
          {data?.blocked
            ? 'Por segurança, este link foi bloqueado: pediram ou digitaram códigos errados vezes demais.'
            : data?.expired ? 'Este link expirou ou foi substituído por um mais novo.' : 'Não encontramos este link.'}
          {pageMode === 'SCHOOL_DEFAULT'
            // Registro autorizado pela escola: não há link novo a pedir.
            ? ' O registro das aulas é autorizado pela escola. Para pedir que as aulas não sejam registradas (ou voltem a ser), fale com a escola pelo WhatsApp.'
            : ' Peça um novo à escola pelo WhatsApp.'}
        </p>
      </div>
    </div>;
  }

  if (done && asAuthorizationMode(data.authorization_mode) === 'SCHOOL_DEFAULT') {
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-xl">
        <CheckCircle2 size={48} className="mx-auto mb-4 text-emerald-500" />
        <h1 className="mb-2 text-xl font-black text-slate-800">Pedido registrado</h1>
        <p className="text-sm text-slate-500">
          As próximas aulas acontecem normalmente, sem transcrição. Para voltar a ter as aulas registradas, fale com a escola pelo WhatsApp.
        </p>
        {done.phone && <p className="mt-3 text-xs text-slate-400">Confirmado pelo WhatsApp {done.phone}.</p>}
      </div>
    </div>;
  }

  if (done) {
    const accepted = done.decision === 'ACCEPTED';
    return <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-xl">
        {accepted
          ? <CheckCircle2 size={48} className="mx-auto mb-4 text-emerald-500" />
          : <XCircle size={48} className="mx-auto mb-4 text-slate-400" />}
        <h1 className="mb-2 text-xl font-black text-slate-800">{accepted ? 'Autorização registrada' : 'Resposta registrada'}</h1>
        <p className="text-sm text-slate-500">
          {accepted
            ? 'Obrigado! As próximas aulas passam a ser transcritas para registrar o que foi trabalhado.'
            : 'As aulas continuam normalmente, sem transcrição.'} Se mudar de ideia, é só abrir este mesmo link de novo.
        </p>
        {done.phone && <p className="mt-3 text-xs text-slate-400">Confirmado pelo WhatsApp {done.phone}.</p>}
      </div>
    </div>;
  }

  const current = asDecision(data.current_decision);
  const notEffective = current === 'ACCEPTED' && data.current_effective === false
    ? asNotEffectiveReason(data.current_not_effective_reason) || 'GUARDIAN_REQUIRED'
    : null;
  const whoLabel = relation === 'SELF' ? 'do aluno' : 'do responsável';
  const termText = fillTermMarkers(data.term_body, asTermSchoolIdentity(data.school_identity, data.school_name));
  const schoolDefault = asAuthorizationMode(data.authorization_mode) === 'SCHOOL_DEFAULT';
  const objected = isObjection(data.current_decision);

  return <div className="min-h-screen bg-slate-100 px-4 py-8">
    <div className="mx-auto max-w-lg space-y-4">
      <div className="text-center">
        <ShieldCheck size={32} className="mx-auto mb-2 text-[#002366]" />
        <h1 className="text-xl font-black text-slate-800">Registro das aulas</h1>
        <p className="mt-1 text-xs font-medium text-slate-500">{data.school_name || 'Wise Wolf'} · {schoolDefault ? 'aviso' : 'termo'} {data.term_version}</p>
      </div>

      <div className="space-y-5 rounded-3xl border border-slate-200 bg-white p-6 shadow-xs">
        {schoolDefault
          ? <p className="text-sm text-slate-600">
              As aulas de <b className="text-slate-800">{firstName}</b> são registradas pela escola (faz parte das aulas). Leia o aviso abaixo.
              {objected ? '' : ' Se você não quiser que as aulas sejam registradas, peça aqui: elas continuam normalmente, só que sem transcrição.'}
            </p>
          : <p className="text-sm text-slate-600">
              Este termo é sobre as aulas de <b className="text-slate-800">{firstName}</b>. Leia com calma e responda abaixo.
            </p>}
        {schoolDefault
          ? <p role="status" className={`rounded-2xl p-3 text-xs ${objected ? 'bg-amber-50 font-semibold text-amber-800' : 'bg-slate-50 text-slate-600'}`}>
              {objected
                ? 'Situação atual: já existe o pedido para não registrar as aulas. Para voltar a ter as aulas registradas, fale com a escola pelo WhatsApp.'
                : 'Situação atual: registro autorizado pela escola.'}
            </p>
          : notEffective
          ? <p role="status" className="rounded-2xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">
              {notEffectiveText(notEffective, firstName, data.decided_term_version)}
            </p>
          : current !== 'NONE' && <p className="rounded-2xl bg-slate-50 p-3 text-xs text-slate-600">
              Situação atual: <b>{DECISION_LABEL[current]}</b>. Você pode responder de novo; vale a resposta mais recente.
            </p>}

        <div className="max-h-[50vh] overflow-y-auto whitespace-pre-line rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
          {termText}
        </div>

        {!(schoolDefault && objected) && <>
        {guardianReason
          ? <p className="rounded-2xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">
              {schoolDefault
                ? `Como ${firstName} é menor de idade (ou a escola não confirmou a idade), o pedido para não registrar é feito pelo responsável legal.`
                : guardianReasonText(guardianReason, firstName)}
            </p>
          : <fieldset className="space-y-2">
              <legend className="mb-1 text-[10px] font-black uppercase tracking-widest text-slate-500">Quem está respondendo</legend>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="relation" checked={relation === 'SELF'} onChange={() => chooseRelation('SELF')} />
                Sou o aluno
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="relation" checked={relation === 'GUARDIAN'} onChange={() => chooseRelation('GUARDIAN')} />
                Sou o responsável
              </label>
            </fieldset>}

        <label className="block">
          <span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-slate-500">Seu nome completo</span>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            autoComplete="name"
            className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base text-slate-800 outline-hidden focus:border-[#002366] focus:ring-2 focus:ring-[#002366]/30"
          />
        </label>

        {relation && <section aria-label="Confirmação pelo WhatsApp" className="space-y-3 rounded-2xl border border-slate-200 p-4">
          <p className="flex items-start gap-2 text-sm text-slate-700">
            <MessageCircle size={16} className="mt-0.5 shrink-0 text-emerald-600" />
            {targetPhone
              ? <span>Para confirmar que é você, mandamos um código de 6 dígitos para o WhatsApp {whoLabel} cadastrado na escola: <b>{targetPhone}</b>.</span>
              : canSendCode
                ? <span>Para confirmar que é você, mandamos um código de 6 dígitos para o WhatsApp {whoLabel} cadastrado na escola.</span>
                : schoolDefault
                  ? <span>A escola não tem o WhatsApp {whoLabel} no cadastro. Para pedir que as aulas não sejam registradas, fale com a escola pelo WhatsApp.</span>
                  : <span>A escola não tem o WhatsApp {whoLabel} no cadastro. Peça à escola para cadastrar e mandar um link novo.</span>}
          </p>
          {canSendCode && <button type="button" disabled={!!busy} onClick={() => void sendCode()}
            className="w-full rounded-2xl border border-emerald-600 py-3 text-[11px] font-black uppercase tracking-widest text-emerald-700 hover:bg-emerald-50 disabled:opacity-40">
            {busy === 'code' ? 'Enviando…' : codeReady ? 'Reenviar código' : 'Enviar código pelo WhatsApp'}
          </button>}
          {codeReady && <>
            <p role="status" className="text-xs text-slate-500">
              Código enviado para {sentTo?.phone}. Ele vale por 10 minutos.
              {sentTo?.uncertain ? ' Se não chegar em 1 minuto, peça outro.' : ''}
            </p>
            <label className="block">
              <span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-slate-500">Código recebido</span>
              <input
                value={code}
                onChange={event => setCode(onlyDigits(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={CODE_LENGTH}
                aria-label="Código recebido"
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-center font-mono text-2xl tracking-[0.5em] text-slate-800 outline-hidden focus:border-[#002366] focus:ring-2 focus:ring-[#002366]/30"
              />
            </label>
          </>}
        </section>}

        {termChanged && <p role="status" className="rounded-2xl bg-amber-50 p-3 text-xs font-semibold text-amber-800">
          {termChanged}
        </p>}
        {error && <p role="alert" className="text-xs font-bold text-red-600">{error}</p>}

        {schoolDefault
          ? <button type="button" disabled={!!busy || !codeReady || !isSixDigitCode(code)} onClick={() => void decide(false)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#002366] py-4 text-[11px] font-black uppercase tracking-widest text-white hover:bg-blue-900 disabled:opacity-40">
              {busy === 'decide' ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />} Não quero que as aulas sejam registradas
            </button>
          : <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" disabled={!!busy || !codeReady || !isSixDigitCode(code)} onClick={() => void decide(true)}
            className="flex items-center justify-center gap-2 rounded-2xl bg-[#002366] py-4 text-[11px] font-black uppercase tracking-widest text-white hover:bg-blue-900 disabled:opacity-40">
            {busy === 'decide' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Autorizo
          </button>
          <button type="button" disabled={!!busy || !codeReady || !isSixDigitCode(code)} onClick={() => void decide(false)}
            className="rounded-2xl border border-slate-300 py-4 text-[11px] font-black uppercase tracking-widest text-slate-600 hover:bg-slate-50 disabled:opacity-40">
            Não autorizo
          </button>
        </div>}
        <p className="text-center text-[10px] leading-relaxed text-slate-400">
          Registramos o nome digitado, a data e a hora da resposta, o endereço de conexão (IP) e o WhatsApp (com parte do número oculta) que recebeu o código.
        </p>
        </>}
      </div>
    </div>
  </div>;
}
