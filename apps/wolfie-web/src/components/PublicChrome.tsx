import { ArrowRight, Menu, X } from "lucide-react";
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
    <WolfieLink href="/" className="inline-flex shrink-0 items-center" ariaLabel="Wise Wolf — Wolfie AI Tutor — início">
      <span className={`${onDark ? "px-1" : "min-w-[113px] rounded-[15px] bg-[#17191f] px-3 py-2 shadow-[0_10px_28px_rgba(24,25,31,.14)]"} inline-flex shrink-0 items-center justify-center`}>
        <span
          aria-hidden="true"
          className={`${compact ? "h-6 w-[76px]" : "h-7 w-[89px]"} block shrink-0 bg-contain bg-center bg-no-repeat`}
          style={{ backgroundImage: "url('/assets/wolfie/brand/wise-wolf-logo-horizontal-dark.png')" }}
        />
      </span>
      <span className="sr-only">Wolfie AI Tutor</span>
    </WolfieLink>
  );
}

export function PublicHeader() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3 sm:px-5 lg:px-10 lg:pt-4">
      <div className="pointer-events-auto mx-auto flex min-h-[66px] max-w-[1380px] items-center justify-between rounded-[26px] border border-black/[.065] bg-white/[.98] px-3.5 shadow-[0_14px_45px_rgba(31,32,38,.09)] sm:px-5">
        <WolfieBrand />
        <nav className="hidden items-center gap-7 lg:flex" aria-label="Navegação principal">
          <WolfieLink href="/como-funciona" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Como funciona</WolfieLink>
          <a href="/#experiencias" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Cenários</a>
          <a href="/#feedback" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Feedback</a>
          <WolfieLink href="/planos" className="text-[13px] font-bold text-[#4f5561] transition hover:text-[#111318]">Planos</WolfieLink>
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
        <nav className="pointer-events-auto mx-auto mt-2 grid max-w-[1380px] gap-1 rounded-[22px] border border-black/[.07] bg-white p-3 shadow-[0_22px_60px_rgba(30,31,36,.12)] md:hidden" aria-label="Navegação móvel">
          <WolfieLink href="/como-funciona" className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]" ariaLabel="Como funciona"><span onClick={close}>Como funciona</span></WolfieLink>
          <a href="/#experiencias" onClick={close} className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]">Cenários</a>
          <a href="/#feedback" onClick={close} className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]">Feedback</a>
          <WolfieLink href="/planos" className="rounded-xl px-4 py-3 font-bold text-[#3e424b] hover:bg-[#f6f6f8]"><span onClick={close}>Planos</span></WolfieLink>
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
          <WolfieLink href="/planos" className="hover:text-[#171717]">Planos</WolfieLink>
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
