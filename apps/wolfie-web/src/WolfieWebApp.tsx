import { useEffect } from "react";
import { AccessPage, HowItWorksPage, LandingPage } from "./components/LandingPage";
import { LoginPage, AuthenticatedWolfieApp } from "./components/AuthPages";
import { QuizPage, QuizResultPage } from "./components/QuizPages";
import { PrivacyPage, TermsPage } from "./components/LegalPages";
import { useWolfiePath, WolfieLink } from "./router";

const pageTitles: Record<string, string> = {
  "/": "Wolfie AI Tutor — Inglês para a vida real",
  "/como-funciona": "Como funciona — Wolfie AI Tutor",
  "/quiz": "Descubra seu treino — Wolfie AI Tutor",
  "/quiz/resultado": "Seu treino recomendado — Wolfie AI Tutor",
  "/planos": "Acesso — Wolfie AI Tutor",
  "/entrar": "Entrar — Wolfie AI Tutor",
  "/privacidade": "Privacidade — Wolfie AI Tutor",
  "/termos": "Termos de uso — Wolfie AI Tutor",
};

const pageDescriptions: Record<string, string> = {
  "/": "Pratique inglês por voz e texto em reuniões, entrevistas, apresentações, viagens e outras situações reais com o Wolfie AI Tutor.",
  "/como-funciona": "Veja como o Wolfie transforma seu objetivo em uma experiência real de inglês com prática e feedback.",
  "/quiz": "Responda oito perguntas objetivas e descubra qual experiência do Wolfie combina com seu objetivo atual.",
  "/planos": "Entenda como alunos e novos interessados podem acessar o Wolfie AI Tutor.",
  "/privacidade": "Entenda quais dados o Wolfie usa, por quanto tempo e como exercer seus direitos de privacidade.",
  "/termos": "Conheça as regras de uso do diagnóstico e do Wolfie AI Tutor.",
};

export function WolfieWebApp() {
  const route = useWolfiePath();
  const pathname = route.split("?")[0].replace(/\/+$/, "") || "/";

  useEffect(() => {
    document.documentElement.lang = "pt-BR";
    document.title = pathname.startsWith("/app")
      ? "Praticar — Wolfie AI Tutor"
      : pageTitles[pathname] ?? "Wolfie AI Tutor";
    const privateRoute = pathname.startsWith("/app") ||
      pathname === "/entrar" || pathname === "/quiz/resultado";
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    robots?.setAttribute("content", privateRoute ? "noindex, nofollow" : "index, follow");
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    description?.setAttribute(
      "content",
      pageDescriptions[pathname] ?? pageDescriptions["/"],
    );
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    canonical?.setAttribute(
      "href",
      privateRoute
        ? "https://wolfie.wisewolflanguage.com.br/"
        : `https://wolfie.wisewolflanguage.com.br${pathname}`,
    );
  }, [pathname]);

  if (pathname === "/") return <LandingPage />;
  if (pathname === "/como-funciona") return <HowItWorksPage />;
  if (pathname === "/quiz") return <QuizPage />;
  if (pathname === "/quiz/resultado") return <QuizResultPage />;
  if (pathname === "/planos") return <AccessPage />;
  if (pathname === "/entrar") return <LoginPage />;
  if (pathname === "/privacidade") return <PrivacyPage />;
  if (pathname === "/termos") return <TermsPage />;
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    return <AuthenticatedWolfieApp />;
  }

  return (
    <div className="grid min-h-screen place-items-center bg-white px-5 text-center text-[#202126]">
      <div><p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#e72d3d]">404</p><h1 className="mt-4 font-display text-4xl font-extrabold">Esta rota não existe.</h1><WolfieLink href="/" className="mt-7 inline-flex min-h-[52px] items-center rounded-full bg-[#e72d3d] px-6 py-3.5 font-extrabold text-white">Voltar ao início</WolfieLink></div>
    </div>
  );
}
