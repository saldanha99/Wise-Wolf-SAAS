import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AlertCircle, CheckCircle2, ChevronDown, FileSignature, Loader2, XCircle } from 'lucide-react';
import { termLinkErrorMessage, termLinkReasonMessage, type TermLinkView } from '../lib/studentTermLink';

// Aceite do termo individual pelo link do WhatsApp (sem login). O link é
// pessoal: o servidor só age como quem o recebeu, pela mesma regra do portal.
// Nada de valor pago pelo aluno chega aqui — só o valor da aula do professor.

const brl = (v: number | null | undefined) =>
    Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateBr = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '');

type IdentityForm = { kind: 'COMPANY' | 'INDIVIDUAL'; companyName: string; cnpj: string; companyAddress: string; representativeCpf: string };

const StudentTermSign: React.FC = () => {
    const token = new URLSearchParams(window.location.search).get('t') || '';
    const [loading, setLoading] = useState(true);
    const [view, setView] = useState<TermLinkView | null>(null);
    const [blocked, setBlocked] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState<'signed' | 'declined' | null>(null);
    const [showBody, setShowBody] = useState(false);
    const [typedName, setTypedName] = useState('');
    const [accepted, setAccepted] = useState(false);
    const [identity, setIdentity] = useState<IdentityForm>({ kind: 'INDIVIDUAL', companyName: '', cnpj: '', companyAddress: '', representativeCpf: '' });
    const [authority, setAuthority] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        const { data, error: rpcError } = await supabase.rpc('student_term_link_view', { p_token: token });
        const res = data as TermLinkView | null;
        if (rpcError || !res) setBlocked('Não foi possível abrir agora. Tente de novo em instantes.');
        else if (!res.ok) setBlocked(termLinkReasonMessage(res.reason));
        else setView(res);
        setLoading(false);
    }, [token]);

    useEffect(() => {
        if (!/^[0-9a-f]{64}$/.test(token)) {
            setBlocked(termLinkReasonMessage('invalid'));
            setLoading(false);
            return;
        }
        void load();
    }, [token, load]);

    const act = async (action: 'identity' | 'sign' | 'decline', payload: Record<string, unknown>) => {
        setError('');
        setBusy(true);
        const { data, error: rpcError } = await supabase.rpc('student_term_link_act', { p_token: token, p_action: action, p_payload: payload });
        setBusy(false);
        const res = data as { ok?: boolean; error?: string } | null;
        if (rpcError || !res?.ok) {
            setError(termLinkErrorMessage(res?.error || rpcError?.message));
            return false;
        }
        return true;
    };

    const saveIdentity = async () => {
        const payload = identity.kind === 'INDIVIDUAL'
            ? { kind: 'INDIVIDUAL', representativeCpf: identity.representativeCpf, companyAddress: identity.companyAddress, representativeHasAuthority: authority }
            : { kind: 'COMPANY', companyName: identity.companyName, cnpj: identity.cnpj, companyAddress: identity.companyAddress, representativeCpf: identity.representativeCpf, representativeHasAuthority: authority };
        if (await act('identity', payload)) await load();
    };

    const sign = async () => {
        if (!view) return;
        if (await act('sign', { typed_name: typedName, content_hash: view.content_hash, accepted: true, has_authority: true })) setDone('signed');
    };

    const decline = async () => {
        if (!window.confirm('Confirmar que você não pode atender este aluno? A escola será avisada para buscar outro professor.')) return;
        if (await act('decline', {})) setDone('declined');
    };

    const shell = (children: React.ReactNode) => (
        <div className="min-h-screen bg-slate-100 py-8 px-4"><div className="max-w-lg mx-auto space-y-4">{children}</div></div>
    );

    if (loading) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-100 gap-4">
                <Loader2 className="animate-spin text-[#002366]" size={40} />
                <p className="text-slate-500 font-bold uppercase tracking-widest text-[11px]">Carregando…</p>
            </div>
        );
    }

    if (blocked || !view) {
        return shell(
            <div className="bg-white p-8 rounded-3xl shadow-xl text-center">
                <AlertCircle size={44} className="text-amber-500 mx-auto mb-4" />
                <p className="text-slate-700 text-sm font-semibold">{blocked}</p>
            </div>,
        );
    }

    if (done) {
        return shell(
            <div className="bg-white p-8 rounded-3xl shadow-xl text-center">
                {done === 'signed' ? <CheckCircle2 size={48} className="text-emerald-500 mx-auto mb-4" /> : <XCircle size={48} className="text-slate-400 mx-auto mb-4" />}
                <h2 className="text-xl font-black text-slate-800 mb-2">{done === 'signed' ? 'Assinado ✅' : 'Recusa registrada'}</h2>
                <p className="text-slate-500 text-sm">
                    {done === 'signed'
                        ? view.signer === 'TEACHER'
                            ? `Obrigado! ${view.student_name} está confirmado(a) com você. Assim que tudo estiver assinado, a aula entra na sua agenda.`
                            : 'Assinatura da escola registrada. Quando o professor também assinar, a matrícula é liberada sozinha.'
                        : 'A escola foi avisada e vai buscar outro professor para este aluno.'}
                </p>
                <p className="text-[11px] text-slate-400 mt-6">A via fica disponível no portal, em Meu Contrato → Termos por aluno. Você pode fechar esta página.</p>
            </div>,
        );
    }

    const isTeacher = view.signer === 'TEACHER';
    const nameOk = typedName.trim().toLowerCase() === (view.signer_name || '').trim().toLowerCase();

    return shell(
        <>
            <div className="text-center">
                <FileSignature size={32} className="text-[#002366] mx-auto mb-2" />
                <h1 className="text-xl font-black text-slate-800">{isTeacher ? 'Aluno novo para você' : 'Termo para a escola assinar'}</h1>
                <p className="text-slate-500 text-xs font-medium mt-1">{view.school_name}</p>
            </div>

            <div className="bg-white rounded-3xl shadow-xs border border-slate-200 p-6 space-y-4" data-testid="term-summary">
                <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Aluno</p>
                    <p className="text-lg font-black text-slate-800">{view.student_name}</p>
                </div>
                {!isTeacher && (
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Professor</p>
                        <p className="text-sm font-bold text-slate-700">{view.teacher_name}</p>
                    </div>
                )}
                <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Aulas</p>
                    <p className="text-sm font-bold text-slate-700">{view.agenda}</p>
                    <p className="text-xs text-slate-500">A partir de {dateBr(view.starts_on)}{view.ends_on ? ` até ${dateBr(view.ends_on)}` : ''}</p>
                </div>
                <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{isTeacher ? 'Seu valor' : 'Valor do professor'}</p>
                    <p className="text-sm font-bold text-slate-700">{brl(view.unit_rate)} a cada 30 minutos de aula dada</p>
                </div>
                <ul className="text-[11px] text-slate-500 space-y-1.5 border-t border-slate-100 pt-4">
                    {isTeacher ? (
                        <>
                            <li>• Ao assinar, você assume este aluno nestes dias e horários e responde pelas aulas dele.</li>
                            <li>• Imprevisto: avise a escola o quanto antes (se possível, com 24 h).</li>
                            <li>• Falta sem justificativa: multa de 2 vezes o valor da aula perdida.</li>
                            <li>• Lançar aula que não aconteceu: devolução do que recebeu, multa de 10 vezes o valor de cada aula e fim dos seus atendimentos com a escola.</li>
                            <li>• Para deixar o aluno, avise com 30 dias de antecedência e siga dando as aulas até lá. Sem esse aviso: multa de 2 meses de honorários deste aluno.</li>
                            <li>• Toda multa só vale depois que você for ouvido(a) (5 dias úteis). Doença ou força maior comprovadas não geram multa.</li>
                        </>
                    ) : (
                        <li>• Assinatura da escola sobre o termo individual deste atendimento.</li>
                    )}
                </ul>
                <button type="button" onClick={() => setShowBody(v => !v)} className="w-full flex items-center justify-between text-xs font-bold text-[#002366]">
                    Ler o termo completo
                    <ChevronDown size={16} className={showBody ? 'rotate-180 transition-transform' : 'transition-transform'} />
                </button>
                {showBody && (
                    <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-slate-600 bg-slate-50 border border-slate-200 rounded-2xl p-4 max-h-96 overflow-y-auto font-sans">{view.body}</pre>
                )}
            </div>

            <div className="bg-white rounded-3xl shadow-xs border border-slate-200 p-6 space-y-4">
                {view.needs_identity ? (
                    <>
                        <p className="text-sm font-black text-slate-800">Primeiro, seus dados de prestador (só desta vez)</p>
                        <div className="grid grid-cols-2 gap-2">
                            {(['INDIVIDUAL', 'COMPANY'] as const).map(k => (
                                <button key={k} type="button" onClick={() => setIdentity(f => ({ ...f, kind: k }))}
                                    className={`rounded-xl border px-3 py-2.5 text-xs font-bold ${identity.kind === k ? 'border-[#002366] bg-[#002366] text-white' : 'border-slate-200 text-slate-600'}`}>
                                    {k === 'INDIVIDUAL' ? 'Sou autônomo (CPF)' : 'Tenho CNPJ'}
                                </button>
                            ))}
                        </div>
                        {identity.kind === 'COMPANY' && (
                            <>
                                <input aria-label="Razão social" placeholder="Razão social" value={identity.companyName} onChange={e => setIdentity(f => ({ ...f, companyName: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-base" />
                                <input aria-label="CNPJ" placeholder="CNPJ" value={identity.cnpj} onChange={e => setIdentity(f => ({ ...f, cnpj: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-base" />
                            </>
                        )}
                        <input aria-label="CPF" placeholder={identity.kind === 'COMPANY' ? 'CPF do responsável' : 'Seu CPF'} inputMode="numeric" value={identity.representativeCpf} onChange={e => setIdentity(f => ({ ...f, representativeCpf: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-base" />
                        <input aria-label="Endereço" placeholder="Endereço completo" value={identity.companyAddress} onChange={e => setIdentity(f => ({ ...f, companyAddress: e.target.value }))} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-base" />
                        <label className="flex items-start gap-2 text-xs text-slate-600">
                            <input type="checkbox" checked={authority} onChange={e => setAuthority(e.target.checked)} className="mt-0.5" />
                            {identity.kind === 'COMPANY' ? 'Declaro que os dados são verdadeiros e que represento a empresa.' : 'Declaro que os dados são verdadeiros e que contrato em nome próprio.'}
                        </label>
                        {error && <p className="text-xs text-red-500 font-bold">{error}</p>}
                        <button type="button" onClick={saveIdentity} disabled={busy || !authority} className="w-full py-4 bg-[#002366] text-white rounded-2xl font-black text-[11px] uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2">
                            {busy && <Loader2 size={14} className="animate-spin" />} Salvar e continuar
                        </button>
                    </>
                ) : (
                    <>
                        <label className="flex items-start gap-2 text-xs text-slate-600">
                            <input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} className="mt-0.5" />
                            Li o termo e concordo com as condições{isTeacher ? '' : ', em nome da escola'}.
                        </label>
                        <div>
                            <label htmlFor="term-typed-name" className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2 block">Assine digitando seu nome completo</label>
                            <input id="term-typed-name" value={typedName} onChange={e => setTypedName(e.target.value)} placeholder={view.signer_name} autoComplete="off"
                                className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-2xl text-base text-slate-800" style={{ fontFamily: 'cursive' }} />
                            {typedName.trim().length > 3 && !nameOk && <p className="text-[11px] text-amber-600 mt-1">Digite o nome exatamente como no cadastro: {view.signer_name}</p>}
                        </div>
                        {error && <p className="text-xs text-red-500 font-bold">{error}</p>}
                        <button type="button" onClick={sign} disabled={busy || !accepted || !nameOk} className="w-full py-4 bg-emerald-600 text-white rounded-2xl font-black text-[11px] uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2">
                            {busy ? <Loader2 size={14} className="animate-spin" /> : <FileSignature size={14} />} {isTeacher ? 'Aceitar aluno' : 'Assinar pela escola'}
                        </button>
                        {isTeacher && (
                            <button type="button" onClick={decline} disabled={busy} className="w-full py-3 text-xs font-bold text-slate-500 underline">Não posso atender</button>
                        )}
                        <p className="text-[10px] text-slate-400 text-center leading-relaxed">
                            Link pessoal enviado ao seu WhatsApp. Registramos o texto assinado, data, hora e IP. Vale até {new Date(view.expires_at).toLocaleDateString('pt-BR')}.
                        </p>
                    </>
                )}
            </div>
        </>,
    );
};

export default StudentTermSign;
