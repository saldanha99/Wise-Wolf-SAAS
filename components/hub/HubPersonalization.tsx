import React, { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Headphones, Keyboard, Loader2, Mic2, Sparkles, Target, UserRound } from 'lucide-react';
import { updateHubPreferences } from './hubService';
import type { HubAudience, HubPreferences } from './types';

interface HubPersonalizationProps {
  accountId: string;
  accountName: string;
  audience: HubAudience;
  initial?: HubPreferences;
  onComplete: () => Promise<void>;
}

const AUDIENCE_COPY: Record<HubAudience, { eyebrow: string; title: string; rolePlaceholder: string; goalPlaceholder: string }> = {
  EDUCATOR: {
    eyebrow: 'Seu espaço de criação',
    title: 'Vamos adaptar o Hub à forma como você ensina.',
    rolePlaceholder: 'Ex.: professora de adultos, inglês corporativo, aulas particulares',
    goalPlaceholder: 'Ex.: preparar aulas mais autorais e reduzir meu tempo de planejamento',
  },
  LEARNER: {
    eyebrow: 'Sua jornada em inglês',
    title: 'Vamos fazer o Wolfie praticar o inglês que você realmente precisa.',
    rolePlaceholder: 'Ex.: médica, estudante, profissional de tecnologia, viajante',
    goalPlaceholder: 'Ex.: participar de reuniões internacionais com mais segurança',
  },
  INSTITUTION: {
    eyebrow: 'Sua operação pedagógica',
    title: 'Vamos configurar uma experiência à altura da sua instituição.',
    rolePlaceholder: 'Ex.: escola de idiomas, universidade, treinamento corporativo',
    goalPlaceholder: 'Ex.: padronizar qualidade pedagógica sem perder a identidade da equipe',
  },
};

const LEVELS = [
  { value: 'A1', label: 'A1', description: 'Estou começando' },
  { value: 'A2', label: 'A2', description: 'Consigo lidar com o básico' },
  { value: 'B1', label: 'B1', description: 'Já me comunico' },
  { value: 'B2', label: 'B2', description: 'Quero ganhar naturalidade' },
  { value: 'C1', label: 'C1', description: 'Uso inglês com autonomia' },
  { value: 'C2', label: 'C2', description: 'Busco precisão avançada' },
] as const;

const MODALITIES = [
  { value: 'voice', label: 'Falar e ouvir', description: 'Priorizar conversação', icon: Mic2 },
  { value: 'mixed', label: 'Experiência completa', description: 'Combinar voz, texto e prática', icon: Headphones },
  { value: 'text', label: 'Ler e escrever', description: 'Começar pelo texto', icon: Keyboard },
] as const;

const HubPersonalization: React.FC<HubPersonalizationProps> = ({ accountId, accountName, audience, initial, onComplete }) => {
  const [step, setStep] = useState(0);
  const [level, setLevel] = useState<HubPreferences['level']>(initial?.level || 'B1');
  const [role, setRole] = useState(initial?.role || '');
  const [goal, setGoal] = useState(initial?.goal || '');
  const [interests, setInterests] = useState(initial?.interests || '');
  const [modality, setModality] = useState<HubPreferences['preferred_modality']>(initial?.preferred_modality || 'mixed');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const copy = AUDIENCE_COPY[audience];
  const firstName = useMemo(() => accountName.trim().split(/\s+/)[0] || 'você', [accountName]);

  const finish = async () => {
    if (role.trim().length < 3 || goal.trim().length < 8) {
      setError('Conte um pouco mais sobre seu momento e seu objetivo. Isso torna as recomendações realmente pessoais.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await updateHubPreferences(accountId, { level, role: role.trim(), goal: goal.trim(), interests: interests.trim(), preferred_modality: modality });
      await onComplete();
    } catch {
      setError('Não foi possível salvar sua configuração agora. Seus dados não foram perdidos; tente novamente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-[#050b16]/95 p-4 text-white backdrop-blur-2xl sm:p-8">
      <div className="mx-auto flex min-h-full max-w-5xl items-center justify-center">
        <section className="w-full overflow-hidden rounded-[2.25rem] border border-white/10 bg-[#0b1426] shadow-[0_40px_140px_-35px_rgba(0,0,0,.95)]">
          <div className="h-1.5 bg-white/5"><div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all" style={{ width: `${step === 0 ? 50 : 100}%` }} /></div>
          <div className="grid lg:grid-cols-[0.78fr_1.22fr]">
            <aside className="relative overflow-hidden border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,.4),transparent_52%),#071020] p-7 lg:border-b-0 lg:border-r lg:p-10">
              <div className="relative">
                <div className="grid size-14 place-items-center rounded-2xl bg-blue-600 text-2xl shadow-2xl shadow-blue-950">🐺</div>
                <p className="mt-8 text-[10px] font-black uppercase tracking-[0.24em] text-blue-400">{copy.eyebrow}</p>
                <h1 className="mt-3 font-[Montserrat] text-3xl font-extrabold leading-tight tracking-tight lg:text-4xl">{firstName}, aqui nada precisa ser genérico.</h1>
                <p className="mt-5 text-sm leading-7 text-slate-400">Suas escolhas orientam materiais, planos de aula e cada conversa com o Wolfie. Você poderá alterá-las quando quiser.</p>
                <div className="mt-8 space-y-3 text-sm font-bold text-slate-300">
                  {['Recomendações alinhadas ao seu contexto', 'Inglês calibrado ao seu nível', 'Objetivos preservados entre experiências'].map((item) => <div key={item} className="flex gap-3"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-emerald-400"><Check size={12} /></span>{item}</div>)}
                </div>
              </div>
            </aside>

            <div className="p-6 sm:p-9 lg:p-11">
              {step === 0 ? (
                <div>
                  <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-blue-500/15 text-blue-400"><UserRound size={19} /></div><p className="text-xs font-black uppercase tracking-[0.18em] text-blue-400">1 de 2 · Seu contexto</p></div>
                  <h2 className="mt-5 text-3xl font-black tracking-tight">{copy.title}</h2>
                  <label className="mt-7 block"><span className="mb-2 block text-xs font-black text-slate-300">Qual é seu momento profissional ou acadêmico?</span><input value={role} onChange={(event) => setRole(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-white/[0.055] px-4 py-4 outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder={copy.rolePlaceholder} /></label>
                  <div className="mt-6"><p className="text-xs font-black text-slate-300">Qual nível melhor representa seu inglês hoje?</p><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{LEVELS.map((item) => <button key={item.value} type="button" onClick={() => setLevel(item.value)} className={`rounded-2xl border p-3 text-left transition ${level === item.value ? 'border-blue-400 bg-blue-500/15 ring-2 ring-blue-500/10' : 'border-white/10 bg-white/[0.03] hover:border-white/20'}`}><span className="text-lg font-black">{item.label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-400">{item.description}</span></button>)}</div></div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-cyan-500/15 text-cyan-400"><Target size={19} /></div><p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-400">2 de 2 · Sua direção</p></div>
                  <h2 className="mt-5 text-3xl font-black tracking-tight">O que faria o Hub valer a pena para você?</h2>
                  <label className="mt-7 block"><span className="mb-2 block text-xs font-black text-slate-300">Seu principal objetivo</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} className="min-h-24 w-full rounded-2xl border border-white/10 bg-white/[0.055] px-4 py-4 outline-none placeholder:text-slate-600 focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10" placeholder={copy.goalPlaceholder} /></label>
                  <label className="mt-4 block"><span className="mb-2 block text-xs font-black text-slate-300">Temas, setores ou interesses</span><input value={interests} onChange={(event) => setInterests(event.target.value)} className="w-full rounded-2xl border border-white/10 bg-white/[0.055] px-4 py-4 outline-none placeholder:text-slate-600 focus:border-cyan-500 focus:ring-4 focus:ring-cyan-500/10" placeholder="Ex.: medicina, viagens, liderança, tecnologia, kids" /></label>
                  <div className="mt-6 grid gap-2 sm:grid-cols-3">{MODALITIES.map(({ value, label, description, icon: Icon }) => <button key={value} type="button" onClick={() => setModality(value)} className={`rounded-2xl border p-4 text-left ${modality === value ? 'border-cyan-400 bg-cyan-500/10' : 'border-white/10 bg-white/[0.03]'}`}><Icon size={19} className={modality === value ? 'text-cyan-400' : 'text-slate-500'} /><span className="mt-3 block text-xs font-black">{label}</span><span className="mt-1 block text-[10px] leading-4 text-slate-400">{description}</span></button>)}</div>
                </div>
              )}
              {error && <p className="mt-5 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4 text-sm font-bold text-rose-200">{error}</p>}
              <div className="mt-8 flex items-center justify-between gap-3">
                {step === 1 ? <button onClick={() => setStep(0)} className="flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-black text-slate-400 hover:text-white"><ArrowLeft size={17} />Voltar</button> : <span />}
                {step === 0 ? <button onClick={() => { if (role.trim().length < 3) return setError('Conte brevemente sobre seu momento para continuarmos.'); setError(''); setStep(1); }} className="flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-4 text-sm font-black shadow-xl shadow-blue-950">Continuar <ArrowRight size={17} /></button> : <button onClick={() => void finish()} disabled={loading} className="flex items-center gap-2 rounded-xl bg-cyan-500 px-6 py-4 text-sm font-black text-slate-950 disabled:opacity-60">{loading ? <Loader2 className="animate-spin" size={17} /> : <Sparkles size={17} />}{loading ? 'Personalizando...' : 'Criar minha experiência'}</button>}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default HubPersonalization;
