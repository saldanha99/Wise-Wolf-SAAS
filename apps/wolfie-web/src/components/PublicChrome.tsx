import { ArrowRight, Menu, Sparkles, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { WolfieLink } from "../router";

export function WolfieBrand({ compact = false }: { compact?: boolean }) {
  return (
    <WolfieLink href="/" className="inline-flex items-center gap-3" ariaLabel="Wolfie AI Tutor — início">
      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500 text-[#07111f] shadow-[0_10px_35px_rgba(251,146,60,.28)]">
        <Sparkles size={20} strokeWidth={2.4} aria-hidden="true" />
      </span>
      <span className={compact ? "sr-only" : "block"}>
        <span className="block font-display text-[17px] font-extrabold leading-none tracking-[-0.035em] text-white">Wolfie</span>
        <span className="mt-1 block text-[9px] font-bold uppercase tracking-[0.26em] text-slate-400">AI Tutor</span>
      </span>
    </WolfieLink>
  );
}

export function PublicHeader() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 sm:pt-5">
      <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between rounded-[22px] border border-white/10 bg-[#07111f]/[.82] px-4 shadow-2xl shadow-black/20 backdrop-blur-xl sm:px-6">
        <WolfieBrand />
        <nav className="hidden items-center gap-8 md:flex" aria-label="Navegação principal">
          <WolfieLink href="/como-funciona" className="text-sm font-semibold text-slate-300 transition hover:text-white">Como funciona</WolfieLink>
          <a href="/#experiencias" className="text-sm font-semibold text-slate-300 transition hover:text-white">Experiências</a>
          <WolfieLink href="/planos" className="text-sm font-semibold text-slate-300 transition hover:text-white">Acesso</WolfieLink>
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          <WolfieLink href="/entrar" className="rounded-full px-4 py-2.5 text-sm font-bold text-white transition hover:bg-white/[.08]">Entrar</WolfieLink>
          <WolfieLink href="/quiz" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#ffbf69] px-5 py-2.5 text-sm font-extrabold text-[#111827] shadow-lg shadow-orange-500/15 transition hover:-translate-y-0.5 hover:bg-[#ffd09a]">
            Descobrir meu treino <ArrowRight size={16} aria-hidden="true" />
          </WolfieLink>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 text-white md:hidden" aria-expanded={open} aria-label={open ? "Fechar menu" : "Abrir menu"}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {open ? (
        <nav className="mx-auto mt-2 grid max-w-7xl gap-1 rounded-[22px] border border-white/10 bg-[#07111f] p-3 shadow-2xl md:hidden" aria-label="Navegação móvel">
          <WolfieLink href="/como-funciona" className="rounded-xl px-4 py-3 font-semibold text-slate-200 hover:bg-white/5" ariaLabel="Como funciona"><span onClick={close}>Como funciona</span></WolfieLink>
          <a href="/#experiencias" onClick={close} className="rounded-xl px-4 py-3 font-semibold text-slate-200 hover:bg-white/5">Experiências</a>
          <WolfieLink href="/planos" className="rounded-xl px-4 py-3 font-semibold text-slate-200 hover:bg-white/5"><span onClick={close}>Acesso</span></WolfieLink>
          <WolfieLink href="/entrar" className="rounded-xl px-4 py-3 font-semibold text-slate-200 hover:bg-white/5"><span onClick={close}>Entrar</span></WolfieLink>
          <WolfieLink href="/quiz" className="mt-1 rounded-xl bg-[#ffbf69] px-4 py-3 text-center font-extrabold text-[#111827]"><span onClick={close}>Descobrir meu treino</span></WolfieLink>
        </nav>
      ) : null}
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-white/[.08] bg-[#050b14] px-5 py-10 text-slate-400">
      <div className="mx-auto grid max-w-7xl gap-8 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <WolfieBrand />
          <p className="mt-5 max-w-md text-sm leading-6">Um produto Wise Wolf para praticar o inglês que você realmente precisa usar.</p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-3 text-sm" aria-label="Navegação do rodapé">
          <WolfieLink href="/como-funciona" className="hover:text-white">Como funciona</WolfieLink>
          <WolfieLink href="/quiz" className="hover:text-white">Diagnóstico</WolfieLink>
          <WolfieLink href="/entrar" className="hover:text-white">Entrar</WolfieLink>
          <WolfieLink href="/privacidade" className="hover:text-white">Privacidade</WolfieLink>
          <WolfieLink href="/termos" className="hover:text-white">Termos</WolfieLink>
          <a href="https://wisewolflanguage.com.br" className="hover:text-white" rel="noreferrer">Wise Wolf</a>
        </nav>
      </div>
      <div className="mx-auto mt-8 max-w-7xl border-t border-white/[.08] pt-6 text-xs text-slate-400">© {new Date().getFullYear()} Wise Wolf. O diagnóstico público é orientativo e não substitui uma avaliação de proficiência.</div>
    </footer>
  );
}

export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#07111f] text-white">
      <PublicHeader />
      {children}
      <PublicFooter />
    </div>
  );
}
