import { ArrowRight, Menu, Sparkles, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { WolfieLink } from "../router";

export function WolfieBrand({
  compact = false,
  tone = "light",
}: {
  compact?: boolean;
  tone?: "light" | "dark";
}) {
  const onDark = tone === "dark";

  return (
    <WolfieLink href="/" className="inline-flex items-center gap-3" ariaLabel="Wolfie AI Tutor — início">
      <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-gradient-to-br from-[#ffb45f] via-[#ff785f] to-[#e72d3d] text-[#17120e] shadow-[0_10px_28px_rgba(231,45,61,.2)]">
        <Sparkles size={20} strokeWidth={2.5} aria-hidden="true" />
      </span>
      <span className={compact ? "sr-only" : "block"}>
        <span className={`block font-display text-[18px] font-extrabold leading-none tracking-[-0.045em] ${onDark ? "text-white" : "text-[#171717]"}`}>Wolfie</span>
        <span className={`mt-1 block text-[9px] font-extrabold uppercase tracking-[0.27em] ${onDark ? "text-slate-400" : "text-[#7b8290]"}`}>AI Tutor</span>
      </span>
    </WolfieLink>
  );
}

export function PublicHeader() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-black/[.06] bg-white/[.9] px-5 backdrop-blur-xl">
      <div className="mx-auto flex min-h-[72px] max-w-7xl items-center justify-between">
        <WolfieBrand />
        <nav className="hidden items-center gap-7 lg:flex" aria-label="Navegação principal">
          <WolfieLink href="/como-funciona" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Como funciona</WolfieLink>
          <a href="/#experiencias" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Cenários</a>
          <a href="/#feedback" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Feedback</a>
          <WolfieLink href="/planos" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Acesso</WolfieLink>
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <WolfieLink href="/entrar" className="rounded-full px-4 py-2.5 text-sm font-extrabold text-[#292c33] transition hover:bg-[#f5f5f7]">Entrar</WolfieLink>
          <WolfieLink href="/quiz" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[#e72d3d] px-5 py-2.5 text-sm font-extrabold text-white shadow-[0_12px_30px_rgba(231,45,61,.2)] transition hover:-translate-y-0.5 hover:bg-[#c91f30]">
            Descobrir meu treino <ArrowRight size={16} aria-hidden="true" />
          </WolfieLink>
        </div>
        <button type="button" onClick={() => setOpen((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-black/10 text-[#171717] md:hidden" aria-expanded={open} aria-label={open ? "Fechar menu" : "Abrir menu"}>
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>
      {open ? (
        <nav className="mx-auto mb-4 grid max-w-7xl gap-1 rounded-[22px] border border-black/[.07] bg-white p-3 shadow-[0_22px_60px_rgba(30,31,36,.12)] md:hidden" aria-label="Navegação móvel">
          <WolfieLink href="/como-funciona" className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]" ariaLabel="Como funciona"><span onClick={close}>Como funciona</span></WolfieLink>
          <a href="/#experiencias" onClick={close} className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]">Cenários</a>
          <a href="/#feedback" onClick={close} className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]">Feedback</a>
          <WolfieLink href="/planos" className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]"><span onClick={close}>Acesso</span></WolfieLink>
          <WolfieLink href="/entrar" className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]"><span onClick={close}>Entrar</span></WolfieLink>
          <WolfieLink href="/quiz" className="mt-1 rounded-xl bg-[#e72d3d] px-4 py-3 text-center font-extrabold text-white"><span onClick={close}>Descobrir meu treino</span></WolfieLink>
        </nav>
      ) : null}
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-black/[.07] bg-white px-5 py-12 text-[#686d77]">
      <div className="mx-auto grid max-w-7xl gap-10 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <WolfieBrand />
          <p className="mt-5 max-w-md text-sm leading-6">Um produto Wise Wolf para praticar o inglês que você realmente precisa usar.</p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-3 text-sm font-semibold" aria-label="Navegação do rodapé">
          <WolfieLink href="/como-funciona" className="hover:text-[#171717]">Como funciona</WolfieLink>
          <WolfieLink href="/quiz" className="hover:text-[#171717]">Diagnóstico</WolfieLink>
          <WolfieLink href="/entrar" className="hover:text-[#171717]">Entrar</WolfieLink>
          <WolfieLink href="/privacidade" className="hover:text-[#171717]">Privacidade</WolfieLink>
          <WolfieLink href="/termos" className="hover:text-[#171717]">Termos</WolfieLink>
          <a href="https://wisewolflanguage.com.br" className="hover:text-[#171717]" rel="noreferrer">Wise Wolf</a>
        </nav>
      </div>
      <div className="mx-auto mt-9 max-w-7xl border-t border-black/[.07] pt-6 text-xs text-[#8a8e96]">© {new Date().getFullYear()} Wise Wolf. O diagnóstico público é orientativo e não substitui uma avaliação de proficiência.</div>
    </footer>
  );
}

export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white text-[#171717]">
      <PublicHeader />
      {children}
      <PublicFooter />
    </div>
  );
}
