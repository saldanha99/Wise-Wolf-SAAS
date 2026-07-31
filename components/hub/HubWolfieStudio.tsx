import React, { useMemo, useState } from 'react';
import { ArrowRight, Bot, ChevronRight, Compass, Loader2, RotateCcw, Send, Sparkles, Target } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { LEARNING_UNIVERSES, recommendExperiences, type LearningExperience } from '../../src/components/wolfie/experienceCatalog';
import type { HubBootstrap } from './types';

interface HubWolfieStudioProps {
  bootstrap: HubBootstrap;
  onRefresh: () => Promise<void>;
  onUpgrade: () => void;
}

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const usageLabel = (used = 0, limit?: number | null) =>
  limit == null ? `${used} interações · ilimitado` : `${Math.max(limit - used, 0)} de ${limit} interações disponíveis`;

const friendlyError = (error: unknown) => {
  const value = error instanceof Error ? error.message : String(error);
  if (value.includes('USAGE_LIMIT_REACHED')) return 'Você concluiu as práticas incluídas neste ciclo.';
  if (value.includes('SUBSCRIPTION_REQUIRED')) return 'Seu acesso precisa ser renovado para continuar praticando.';
  if (value.includes('FEATURE_NOT_INCLUDED')) return 'O Wolfie não está incluído neste plano.';
  return 'A conversa foi preservada, mas o Wolfie não conseguiu responder agora. Tente novamente.';
};

const openingFor = (experience: LearningExperience, level: string) =>
  `Welcome to ${experience.title}. We will work at ${level} level. ${experience.realWorldGoal} What would you like to bring from your real life into this practice?`;

const HubWolfieStudio: React.FC<HubWolfieStudioProps> = ({ bootstrap, onRefresh, onUpgrade }) => {
  const preferences = bootstrap.account.metadata || {};
  const recommended = useMemo(() => recommendExperiences({
    role: preferences.role,
    goal: preferences.goal,
    interests: preferences.interests,
    audience: bootstrap.account.audience === 'LEARNER' ? 'adult' : 'professional',
    preferredModality: preferences.preferred_modality,
  }, 6), [bootstrap.account.audience, preferences.goal, preferences.interests, preferences.preferred_modality, preferences.role]);
  const [level, setLevel] = useState(preferences.level || 'B1');
  const [universeId, setUniverseId] = useState(LEARNING_UNIVERSES[0].id);
  const [experience, setExperience] = useState<LearningExperience>(recommended[0] || LEARNING_UNIVERSES[0].items[0]);
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>(() => [{ role: 'assistant', content: openingFor(recommended[0] || LEARNING_UNIVERSES[0].items[0], preferences.level || 'B1') }]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const entitlement = bootstrap.entitlements['wolfie.turn'];
  const activeUniverse = LEARNING_UNIVERSES.find((item) => item.id === universeId) || LEARNING_UNIVERSES[0];

  const chooseExperience = (next: LearningExperience) => {
    setExperience(next);
    setConversationId(crypto.randomUUID());
    setMessages([{ role: 'assistant', content: openingFor(next, level) }]);
    setError('');
  };

  const send = async () => {
    const current = text.trim();
    if (!current || loading) return;
    setMessages((items) => [...items, { role: 'user', content: current }]);
    setText('');
    setLoading(true);
    setError('');
    try {
      const requestKey = crypto.randomUUID();
      const { data, error: functionError } = await supabase.functions.invoke('wolf-tutor-api', {
        body: {
          hubMode: true,
          text: current,
          studentLevel: level,
          conversationId,
          requestKey,
          includeAudio: false,
          experience: {
            id: experience.id,
            title: experience.title,
            description: experience.description,
            realWorldGoal: experience.realWorldGoal,
            mode: experience.experienceMode,
            sector: experience.sector || null,
            skills: experience.skills,
          },
          learnerProfile: {
            role: preferences.role || null,
            goal: preferences.goal || null,
            interests: preferences.interests || null,
            preferredModality: preferences.preferred_modality || 'mixed',
          },
        },
      });
      if (functionError) throw functionError;
      if (data?.error) throw new Error(data.code || data.error);
      setMessages((items) => [...items, { role: 'assistant', content: data.aiText || 'Let’s keep practicing.' }]);
      await onRefresh();
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2.25rem] bg-[radial-gradient(circle_at_80%_0%,rgba(14,165,233,.25),transparent_38%),#07101f] p-6 text-white shadow-2xl sm:p-8">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.22em] text-sky-400"><Compass size={14} /> Wolfie Personal Studio</div>
            <h1 className="mt-4 font-[Montserrat] text-3xl font-extrabold tracking-tight sm:text-5xl">Pratique o inglês do lugar onde você quer chegar.</h1>
            <p className="mt-4 max-w-2xl leading-7 text-slate-300">Cada universo muda o papel do Wolfie, o vocabulário, a situação e o nível de exigência. Suas recomendações usam seu objetivo e seu contexto.</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.06] px-5 py-4 backdrop-blur"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500">Seu ciclo</p><p className="mt-1 text-sm font-black">{usageLabel(entitlement?.used || 0, entitlement?.limit)}</p><button onClick={onUpgrade} className="mt-2 flex items-center gap-1 text-xs font-black text-sky-400">Comparar planos <ArrowRight size={13} /></button></div>
        </div>
      </section>

      <section>
        <div className="flex items-end justify-between gap-4"><div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-600">Escolhidas para você</p><h2 className="mt-2 text-2xl font-black tracking-tight">Comece por uma situação que importa</h2></div><label className="text-xs font-black text-slate-600">Nível <select value={level} onChange={(event) => { setLevel(event.target.value); setMessages([{ role: 'assistant', content: openingFor(experience, event.target.value) }]); setConversationId(crypto.randomUUID()); }} className="ml-2 rounded-xl border border-slate-200 bg-white px-3 py-2 outline-none">{['A1','A2','B1','B2','C1','C2'].map((item) => <option key={item}>{item}</option>)}</select></label></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{recommended.map((item, index) => <button key={item.id} onClick={() => chooseExperience(item)} className={`group rounded-3xl border p-5 text-left transition ${experience.id === item.id ? 'border-blue-500 bg-blue-50 shadow-lg shadow-blue-100' : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-blue-300'}`}><div className="flex items-center justify-between"><span className="rounded-full bg-slate-950 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.12em] text-white">{index === 0 ? 'Melhor escolha' : item.skills[0]}</span><ChevronRight size={17} className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-blue-500" /></div><h3 className="mt-4 text-lg font-black">{item.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{item.realWorldGoal}</p></button>)}</div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[310px_1fr]">
        <aside className="rounded-[2rem] border border-slate-200 bg-white p-4 shadow-sm">
          <p className="px-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Todos os universos</p>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-2 xl:block xl:space-y-1 xl:overflow-visible">{LEARNING_UNIVERSES.map((universe) => <button key={universe.id} onClick={() => setUniverseId(universe.id)} className={`shrink-0 rounded-xl px-3 py-2.5 text-left text-xs font-black xl:w-full ${universeId === universe.id ? 'bg-slate-950 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{universe.title}</button>)}</div>
          <div className="mt-4 border-t border-slate-100 pt-4"><p className="px-2 text-xs font-black">{activeUniverse.eyebrow}</p><p className="mt-1 px-2 text-[11px] leading-5 text-slate-500">{activeUniverse.description}</p><div className="mt-3 space-y-1">{activeUniverse.items.map((item) => <button key={item.id} onClick={() => chooseExperience(item)} className={`w-full rounded-xl px-3 py-3 text-left ${experience.id === item.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50'}`}><span className="block text-xs font-black">{item.title}</span><span className="mt-1 block text-[10px] text-slate-500">{item.description}</span></button>)}</div></div>
        </aside>

        <section className="flex min-h-[680px] flex-col overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 p-5 sm:p-6"><div className="flex items-start justify-between gap-4"><div className="flex gap-4"><div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-sky-100 text-2xl">🐺</div><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-black">{experience.title}</h2><span className="rounded-full bg-emerald-50 px-2 py-1 text-[9px] font-black uppercase text-emerald-700">Wolfie online</span></div><p className="mt-1 text-xs leading-5 text-slate-500">{experience.realWorldGoal}</p></div></div><button onClick={() => chooseExperience(experience)} className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500" aria-label="Reiniciar experiência"><RotateCcw size={16} /></button></div><div className="mt-4 flex flex-wrap gap-2"><span className="flex items-center gap-1 rounded-full bg-blue-50 px-3 py-1.5 text-[10px] font-black text-blue-700"><Target size={12} /> {level}</span>{experience.skills.map((skill) => <span key={skill} className="rounded-full bg-slate-100 px-3 py-1.5 text-[10px] font-black text-slate-600">{skill}</span>)}</div></header>
          <div className="flex-1 space-y-4 overflow-y-auto bg-[#f5f8fc] p-5 sm:p-7">{messages.map((message, index) => <div key={`${message.role}-${index}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 sm:max-w-[76%] ${message.role === 'user' ? 'rounded-br-sm bg-blue-600 text-white' : 'rounded-bl-sm border border-slate-200 bg-white text-slate-800 shadow-sm'}`}>{message.content}</div></div>)}{loading && <div className="flex justify-start"><div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold text-slate-500"><Loader2 className="animate-spin text-sky-600" size={16} /> Wolfie está adaptando a resposta ao seu contexto...</div></div>}</div>
          {error && <div className="flex items-center justify-between gap-3 border-t border-amber-200 bg-amber-50 p-4 text-xs font-bold text-amber-900"><span>{error}</span><button onClick={onUpgrade} className="shrink-0 text-blue-700">Ver acesso</button></div>}
          <div className="border-t border-slate-200 bg-white p-4 sm:p-5"><div className="flex gap-2"><textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} className="min-h-12 max-h-32 min-w-0 flex-1 resize-none rounded-2xl bg-slate-100 px-4 py-3.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder={`Responda como você responderia em ${experience.title}...`} /><button onClick={() => void send()} disabled={loading || !text.trim()} className="grid size-12 shrink-0 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-100 disabled:opacity-50" aria-label="Enviar resposta"><Send size={18} /></button></div><p className="mt-2 flex items-center gap-1 text-[10px] text-slate-400"><Sparkles size={11} /> Shift + Enter cria uma nova linha. O Wolfie adapta vocabulário e correções ao seu nível.</p></div>
        </section>
      </div>
    </div>
  );
};

export default HubWolfieStudio;
