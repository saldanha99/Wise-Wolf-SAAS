import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, Clock3, ExternalLink, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { User } from '../types';

type BookStatus = 'STARTING' | 'GENERATING' | 'FINALIZING' | 'COMPLETED' | 'FAILED';

interface BookJob {
  id: string;
  status: BookStatus;
  title: string;
  level_tag: string;
  niche: string;
  audience: string;
  book_language: string;
  page_count: number;
  gamma_url: string | null;
  material_id: string | null;
  error_code: string | null;
  provider_credits: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

interface SchoolBookGeneratorProps {
  user: User;
  tenantId?: string;
  niches: Array<{ key: string; label: string }>;
  onLibraryChanged: () => Promise<void>;
}

const JOB_COLUMNS = 'id,status,title,level_tag,niche,audience,book_language,page_count,gamma_url,material_id,error_code,provider_credits,created_at,completed_at';
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const ERROR_MESSAGES: Record<string, string> = {
  GAMMA_NOT_CONFIGURED: 'A integração com o Gamma ainda não foi configurada no servidor.',
  GAMMA_API_KEY_INVALID: 'A credencial do Gamma está inválida. Gere uma nova chave e atualize o secret do servidor.',
  GAMMA_CREDITS_OR_PLAN_REQUIRED: 'O plano ou os créditos da conta Gamma não permitem esta geração.',
  GAMMA_RATE_LIMITED: 'O Gamma atingiu o limite temporário de requisições. Tente novamente em alguns minutos.',
  GAMMA_REQUEST_REJECTED: 'O Gamma recusou a configuração deste livro. Revise os campos e tente novamente.',
  GAMMA_GENERATION_FAILED: 'O Gamma não conseguiu concluir o livro. Nenhum material incompleto foi salvo.',
  GAMMA_EXPORT_UNAVAILABLE: 'O Gamma terminou, mas não disponibilizou o PDF.',
  GAMMA_EXPORT_DOWNLOAD_FAILED: 'O PDF ficou indisponível antes de ser salvo na biblioteca.',
  BOOK_STORAGE_UPLOAD_FAILED: 'O livro foi gerado, mas não foi possível salvá-lo na biblioteca.',
  BOOK_LIBRARY_SAVE_FAILED: 'O PDF foi recebido, mas o cadastro na Biblioteca Master falhou.',
  BOOK_FINALIZATION_FAILED: 'Não foi possível finalizar o livro na biblioteca.',
};

const friendlyError = (code: string | null | undefined) =>
  (code && ERROR_MESSAGES[code]) || 'Não foi possível concluir esta geração.';

const statusLabel = (status: BookStatus) => ({
  STARTING: 'Enviando ao Gamma',
  GENERATING: 'Diagramando o livro',
  FINALIZING: 'Salvando na biblioteca',
  COMPLETED: 'Disponível na biblioteca',
  FAILED: 'Falhou',
})[status];

const isActive = (status: BookStatus) => ['STARTING', 'GENERATING', 'FINALIZING'].includes(status);

const SchoolBookGenerator: React.FC<SchoolBookGeneratorProps> = ({ user, tenantId, niches, onLibraryChanged }) => {
  const [title, setTitle] = useState('Wise Wolf English B1');
  const [level, setLevel] = useState('B1');
  const [niche, setNiche] = useState('GENERAL');
  const [audience, setAudience] = useState('adults');
  const [language, setLanguage] = useState('bilingual');
  const [pageCount, setPageCount] = useState(60);
  const [objective, setObjective] = useState('Comunicar-se com segurança em situações reais do cotidiano, estudo, viagens e trabalho.');
  const [topics, setTopics] = useState('');
  const [jobs, setJobs] = useState<BookJob[]>([]);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pollingRef = useRef(false);
  const announcedCompletedRef = useRef(new Set<string>());

  const loadJobs = useCallback(async () => {
    if (!tenantId) return;
    const { data, error: jobsError } = await supabase
      .from('school_book_generations')
      .select(JOB_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(12);
    if (jobsError) {
      setError('Não foi possível carregar o histórico do gerador.');
      return;
    }
    setJobs((data || []) as BookJob[]);
  }, [tenantId]);

  useEffect(() => {
    setLoading(true);
    void loadJobs().finally(() => setLoading(false));
  }, [loadJobs]);

  const refreshActiveJobs = useCallback(async () => {
    if (pollingRef.current) return;
    const active = jobs.filter((job) => isActive(job.status));
    if (!active.length) return;
    pollingRef.current = true;
    try {
      const refreshed = await Promise.all(active.map(async (job) => {
        const { data } = await supabase.functions.invoke('gamma-book-generator', {
          body: { action: 'status', jobId: job.id },
        });
        return data?.job && typeof data.job.id === 'string' ? data.job as BookJob : job;
      }));
      const byId = new Map(refreshed.map((job) => [job.id, job]));
      let libraryChanged = false;
      for (const job of refreshed) {
        if (job.status === 'COMPLETED' && !announcedCompletedRef.current.has(job.id)) {
          announcedCompletedRef.current.add(job.id);
          libraryChanged = true;
        }
      }
      setJobs((current) => current.map((job) => byId.get(job.id) || job));
      if (libraryChanged) await onLibraryChanged();
    } finally {
      pollingRef.current = false;
    }
  }, [jobs, onLibraryChanged]);

  useEffect(() => {
    if (!jobs.some((job) => isActive(job.status))) return;
    const interval = window.setInterval(() => void refreshActiveJobs(), 8_000);
    return () => window.clearInterval(interval);
  }, [jobs, refreshActiveJobs]);

  const createBook = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tenantId || title.trim().length < 3 || objective.trim().length < 3) return;
    setCreating(true);
    setError('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('gamma-book-generator', {
        body: {
          action: 'create',
          tenantId,
          requestKey: crypto.randomUUID(),
          title: title.trim(),
          level,
          niche,
          audience,
          language,
          pageCount,
          objective: objective.trim(),
          topics,
        },
      });
      if (invokeError || !data?.job) {
        throw new Error(data?.code || data?.error || 'BOOK_CREATE_FAILED');
      }
      setJobs((current) => [data.job as BookJob, ...current.filter((job) => job.id !== data.job.id)].slice(0, 12));
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : '';
      setError(friendlyError(code));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto pb-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
      <form onSubmit={createBook} className="h-fit rounded-[2.5rem] border border-brand-border bg-brand-surface p-6 shadow-sm sm:p-8">
        <div className="mb-6 flex items-start gap-4">
          <div className="rounded-2xl bg-tenant-primary/10 p-3 text-tenant-primary"><Sparkles size={24} /></div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Gamma · Livro completo</p>
            <h3 className="mt-1 text-2xl font-black text-brand-text">Gerar livro didático</h3>
            <p className="mt-2 text-sm text-brand-muted">A plataforma define a progressão página por página; o Gamma cria e diagrama o PDF A4. Ao terminar, o livro entra automaticamente na Biblioteca Master.</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Título</span>
            <input aria-label="Título do livro" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm font-bold outline-none" required />
          </label>
          <label>
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Nível CEFR</span>
            <select aria-label="Nível do livro" value={level} onChange={(event) => setLevel(event.target.value)} className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm font-bold">
              {LEVELS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label>
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Público</span>
            <select aria-label="Público do livro" value={audience} onChange={(event) => setAudience(event.target.value)} className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm font-bold">
              <option value="adults">Adultos</option><option value="teens">Adolescentes</option><option value="kids">Crianças</option>
            </select>
          </label>
          <label>
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Nicho</span>
            <select aria-label="Nicho do livro" value={niche} onChange={(event) => setNiche(event.target.value)} className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm font-bold">
              {niches.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Idioma de apoio</span>
            <select aria-label="Idioma do livro" value={language} onChange={(event) => setLanguage(event.target.value)} className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm font-bold">
              <option value="bilingual">Bilíngue · inglês + português</option><option value="english">Somente inglês</option>
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-brand-muted"><span>Páginas</span><strong className="text-tenant-primary">{pageCount}</strong></span>
            <input aria-label="Quantidade de páginas" type="range" min={12} max={60} step={1} value={pageCount} onChange={(event) => setPageCount(Number(event.target.value))} className="mt-2 w-full accent-[var(--tenant-primary)]" />
          </label>
          <label className="sm:col-span-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Objetivo do aluno</span>
            <textarea aria-label="Objetivo do livro" value={objective} maxLength={1200} rows={3} onChange={(event) => setObjective(event.target.value)} className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm outline-none" required />
          </label>
          <label className="sm:col-span-2">
            <span className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Temas das unidades · opcional</span>
            <textarea aria-label="Temas do livro" value={topics} maxLength={2400} rows={3} onChange={(event) => setTopics(event.target.value)} placeholder="Um por linha. Se ficar vazio, o gerador usa a progressão recomendada para o nível." className="mt-1 w-full rounded-xl bg-brand-surface-2 p-3 text-sm outline-none" />
          </label>
        </div>

        {user.role === 'TEACHER' && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-800">Livros gerados por professor ficam privados e aguardam aprovação da direção, como qualquer material enviado.</p>}
        {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{error}</p>}
        <button type="submit" disabled={creating || !tenantId} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-tenant-primary px-5 py-3.5 text-sm font-black uppercase tracking-wider text-white transition-transform hover:scale-[1.01] disabled:opacity-60">
          {creating ? <RefreshCw size={18} className="animate-spin" /> : <Sparkles size={18} />}
          {creating ? 'Iniciando geração...' : `Gerar livro de ${pageCount} páginas`}
        </button>
      </form>

      <section className="h-fit rounded-[2.5rem] border border-brand-border bg-brand-surface p-6 shadow-sm sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-brand-muted">Acompanhamento</p><h3 className="mt-1 text-xl font-black text-brand-text">Livros recentes</h3></div>
          <button type="button" onClick={() => void refreshActiveJobs()} className="rounded-xl border border-brand-border p-2 text-brand-muted hover:text-tenant-primary" title="Atualizar"><RefreshCw size={17} /></button>
        </div>
        {loading ? <p className="mt-6 text-sm text-brand-muted">Carregando...</p> : jobs.length === 0 ? (
          <div className="mt-6 rounded-2xl bg-brand-surface-2 p-5 text-center"><BookOpen size={24} className="mx-auto text-brand-muted" /><p className="mt-2 text-sm font-bold text-brand-muted">Nenhum livro gerado ainda.</p></div>
        ) : (
          <div className="mt-5 space-y-3">
            {jobs.map((job) => (
              <article key={job.id} className="rounded-2xl border border-brand-border bg-brand-surface-2/60 p-4">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 rounded-xl p-2 ${job.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700' : job.status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                    {job.status === 'COMPLETED' ? <CheckCircle2 size={17} /> : job.status === 'FAILED' ? <TriangleAlert size={17} /> : <Clock3 size={17} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-brand-text">{job.title}</p>
                    <p className="mt-1 text-xs text-brand-muted">{job.level_tag} · {job.page_count} páginas · {statusLabel(job.status)}</p>
                    {job.status === 'FAILED' && <p className="mt-2 text-xs font-bold text-red-600">{friendlyError(job.error_code)}</p>}
                    {job.status === 'COMPLETED' && <p className="mt-2 text-xs font-bold text-emerald-700">PDF salvo. Abra-o na aba Biblioteca.</p>}
                  </div>
                  {job.gamma_url && job.status === 'COMPLETED' && <a href={job.gamma_url} target="_blank" rel="noopener noreferrer" className="rounded-lg p-2 text-brand-muted hover:text-tenant-primary" title="Abrir no Gamma"><ExternalLink size={16} /></a>}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default SchoolBookGenerator;
