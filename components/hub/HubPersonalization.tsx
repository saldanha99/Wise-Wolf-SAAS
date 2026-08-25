import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Headphones, Keyboard, Loader2, Mic2, Sparkles, Target, UserRound, X } from 'lucide-react';
import { updateHubPreferences } from './hubService';
import type { HubAudience, HubPreferences } from './types';

interface HubPersonalizationProps {
  accountId: string;
  accountName: string;
  audience: HubAudience;
  initial?: HubPreferences;
  onComplete: () => Promise<void>;
  onClose?: () => void;
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
  { value: 'voice', label: 'Diálogos', description: 'Priorizar simulações por texto', icon: Mic2 },
  { value: 'mixed', label: 'Equilíbrio', description: 'Variar situações e habilidades', icon: Headphones },
  { value: 'text', label: 'Leitura e escrita', description: 'Priorizar produção textual', icon: Keyboard },
] as const;

const HubPersonalization: React.FC<HubPersonalizationProps> = ({ accountId, accountName, audience, initial, onComplete, onClose }) => {
  const [step, setStep] = useState(0);
  const [level, setLevel] = useState<HubPreferences['level']>(initial?.level || 'B1');
  const [role, setRole] = useState(initial?.role || '');
  const [goal, setGoal] = useState(initial?.goal || '');
  const [interests, setInterests] = useState(initial?.interests || '');
  const [modality, setModality] = useState<HubPreferences['preferred_modality']>(initial?.preferred_modality || 'mixed');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const stepTitleRef = useRef<HTMLHeadingElement>(null);
  const stepMountedRef = useRef(false);
  const copy = AUDIENCE_COPY[audience];
  const firstName = useMemo(() => accountName.trim().split(/\s+/)[0] || 'você', [accountName]);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    }, 0);
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls: HTMLElement[] = dialogRef.current
        ? Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector))
        : [];
      if (controls.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', trapFocus);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!stepMountedRef.current) {
      stepMountedRef.current = true;
      return;
    }
    stepTitleRef.current?.focus();
  }, [step]);

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
    <div className="fixed inset-0 z-[120] overflow-y-auto bg-slate-950/60 p-4 text-brand-text backdrop-blur-sm sm:p-8">
      <div className="mx-auto flex min-h-full max-w-5xl items-center justify-center">
        <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="hub-personalization-title" aria-describedby="hub-personalization-description" aria-busy={loading} tabIndex={-1} className="relative w-full overflow-hidden rounded-[2.25rem] border border-brand-border bg-brand-surface shadow-2xl">
          {onClose && <button type="button" onClick={onClose} className="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-xl border border-brand-border bg-brand-surface text-brand-muted shadow-sm hover:text-brand-text" aria-label="Fechar personalização"><X size={18} /></button>}
          <div className="h-1.5 bg-brand-surface-2"><div className="h-full bg-tenant-primary transition-all" style={{ width: `${step === 0 ? 50 : 100}%` }} /></div>
          <div className="grid lg:grid-cols-[0.78fr_1.22fr]">
            <aside className="relative overflow-hidden border-b border-brand-border bg-brand-surface-2 p-7 lg:border-b-0 lg:border-r lg:p-10">
              <div className="relative">
                <div className="grid size-14 place-items-center rounded-2xl bg-tenant-primary text-2xl shadow-lg shadow-tenant-primary/20">🐺</div>
                <p className="mt-8 text-[10px] font-black uppercase tracking-[0.24em] text-tenant-primary">{copy.eyebrow}</p>
                <h1 id="hub-personalization-title" className="mt-3 font-[Montserrat] text-3xl font-extrabold leading-tight tracking-tight lg:text-4xl">{firstName}, aqui nada precisa ser genérico.</h1>
                <p id="hub-personalization-description" className="mt-5 text-sm leading-7 text-brand-muted">Suas escolhas orientam materiais, planos de aula e cada conversa com o Wolfie. Você poderá alterá-las quando quiser.</p>
                <div className="mt-8 space-y-3 text-sm font-bold text-brand-text">
                  {['Recomendações alinhadas ao seu contexto', 'Inglês calibrado ao seu nível', 'Objetivos preservados entre experiências'].map((item) => <div key={item} className="flex gap-3"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-tenant-primary/10 text-tenant-primary"><Check size={12} /></span>{item}</div>)}
                </div>
              </div>
            </aside>

            <div className="p-6 sm:p-9 lg:p-11">
              {step === 0 ? (
                <div>
                  <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-tenant-primary/10 text-tenant-primary"><UserRound size={19} /></div><p className="text-xs font-black uppercase tracking-[0.18em] text-tenant-primary">1 de 2 · Seu contexto</p></div>
                  <h2 ref={stepTitleRef} tabIndex={-1} className="mt-5 text-3xl font-black tracking-tight outline-none">{copy.title}</h2>
                  <label className="mt-7 block"><span className="mb-2 block text-xs font-black text-brand-text">Qual é seu momento profissional ou acadêmico?</span><input value={role} onChange={(event) => setRole(event.target.value)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-4 text-brand-text outline-none placeholder:text-brand-muted focus:border-tenant-primary focus:ring-4 focus:ring-tenant-primary/10" placeholder={copy.rolePlaceholder} /></label>
                  <div className="mt-6"><p id="hub-personalization-level-label" className="text-xs font-black text-brand-text">Qual nível melhor representa seu inglês hoje?</p><div role="group" aria-labelledby="hub-personalization-level-label" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">{LEVELS.map((item) => <button key={item.value} type="button" aria-pressed={level === item.value} onClick={() => setLevel(item.value)} className={`rounded-2xl border p-3 text-left transition ${level === item.value ? 'border-tenant-primary bg-tenant-primary/10 ring-2 ring-tenant-primary/10' : 'border-brand-border bg-brand-surface-2 hover:border-tenant-primary/40'}`}><span className="text-lg font-black">{item.label}</span><span className="mt-1 block text-[10px] leading-4 text-brand-muted">{item.description}</span></button>)}</div></div>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-tenant-primary/10 text-tenant-primary"><Target size={19} /></div><p className="text-xs font-black uppercase tracking-[0.18em] text-tenant-primary">2 de 2 · Sua direção</p></div>
                  <h2 ref={stepTitleRef} tabIndex={-1} className="mt-5 text-3xl font-black tracking-tight outline-none">O que faria o Hub valer a pena para você?</h2>
                  <label className="mt-7 block"><span className="mb-2 block text-xs font-black text-brand-text">Seu principal objetivo</span><textarea value={goal} onChange={(event) => setGoal(event.target.value)} className="min-h-24 w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-4 text-brand-text outline-none placeholder:text-brand-muted focus:border-tenant-primary focus:ring-4 focus:ring-tenant-primary/10" placeholder={copy.goalPlaceholder} /></label>
                  <label className="mt-4 block"><span className="mb-2 block text-xs font-black text-brand-text">Temas, setores ou interesses</span><input value={interests} onChange={(event) => setInterests(event.target.value)} className="w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-4 text-brand-text outline-none placeholder:text-brand-muted focus:border-tenant-primary focus:ring-4 focus:ring-tenant-primary/10" placeholder="Ex.: medicina, viagens, liderança, tecnologia, kids" /></label>
                  <div role="group" aria-label="Modalidade preferida" className="mt-6 grid gap-2 sm:grid-cols-3">{MODALITIES.map(({ value, label, description, icon: Icon }) => <button key={value} type="button" aria-pressed={modality === value} onClick={() => setModality(value)} className={`rounded-2xl border p-4 text-left ${modality === value ? 'border-tenant-primary bg-tenant-primary/10' : 'border-brand-border bg-brand-surface-2'}`}><Icon size={19} className={modality === value ? 'text-tenant-primary' : 'text-brand-muted'} /><span className="mt-3 block text-xs font-black">{label}</span><span className="mt-1 block text-[10px] leading-4 text-brand-muted">{description}</span></button>)}</div>
                </div>
              )}
              {error && <p className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300" role="alert">{error}</p>}
              <div className="mt-8 flex items-center justify-between gap-3">
                {step === 1 ? <button type="button" onClick={() => setStep(0)} className="flex items-center gap-2 rounded-xl px-3 py-3 text-sm font-black text-brand-muted hover:text-brand-text"><ArrowLeft size={17} />Voltar</button> : <span />}
                {step === 0 ? <button type="button" onClick={() => { if (role.trim().length < 3) return setError('Conte brevemente sobre seu momento para continuarmos.'); setError(''); setStep(1); }} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-6 py-4 text-sm font-black text-white shadow-lg shadow-tenant-primary/20">Continuar <ArrowRight size={17} /></button> : <button type="button" onClick={() => void finish()} disabled={loading} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-6 py-4 text-sm font-black text-white disabled:opacity-60">{loading ? <Loader2 className="animate-spin" size={17} /> : <Sparkles size={17} />}{loading ? 'Personalizando...' : 'Criar minha experiência'}</button>}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default HubPersonalization;
