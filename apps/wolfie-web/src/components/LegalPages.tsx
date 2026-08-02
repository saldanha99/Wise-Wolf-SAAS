import { PublicPage } from "./PublicChrome";
import type { ReactNode } from "react";
import {
  WOLFIE_LEAD_RETENTION_DAYS,
  WOLFIE_PRIVACY_NOTICE_VERSION,
  WOLFIE_QUIZ_RETENTION_DAYS,
} from "../privacy";

function LegalLayout({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <PublicPage>
      <main className="px-5 pb-24 pt-36 sm:pt-44">
        <article className="mx-auto max-w-4xl rounded-[34px] border border-white/10 bg-white/[.035] p-7 sm:p-10 lg:p-12">
          <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[#ffbf69]">{eyebrow}</p>
          <h1 className="mt-4 font-display text-4xl font-extrabold tracking-[-0.045em] text-white sm:text-6xl">{title}</h1>
          <p className="mt-4 text-sm text-slate-300">Versão {WOLFIE_PRIVACY_NOTICE_VERSION} · vigente desde 2 de agosto de 2026</p>
          <div className="mt-10 space-y-9 text-base leading-7 text-slate-300">{children}</div>
        </article>
      </main>
    </PublicPage>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section>
    <h2 className="font-display text-2xl font-extrabold text-white">{title}</h2>
    <div className="mt-3 space-y-3">{children}</div>
  </section>
);

export function PrivacyPage() {
  return (
    <LegalLayout eyebrow="Privacidade" title="Seus dados no Wolfie">
      <Section title="Quem cuida dos dados">
        <p>A Wise Wolf é responsável pelo tratamento realizado neste site e no Wolfie AI Tutor. Solicitações sobre privacidade podem ser feitas pelos canais oficiais disponíveis em <a className="font-bold text-amber-200 underline underline-offset-4" href="https://wisewolflanguage.com.br" rel="noreferrer">wisewolflanguage.com.br</a>.</p>
      </Section>
      <Section title="O que coletamos e por quê">
        <p>As oito respostas do diagnóstico são escolhas fechadas usadas para recomendar um cenário, nível autodeclarado, foco e ritmo inicial. Elas não são uma avaliação de proficiência.</p>
        <p>Nome, e-mail e WhatsApp opcional só são coletados quando você pede contato e marca o consentimento. Usamos esses dados para responder ao pedido, apresentar o Wolfie e registrar a autorização correspondente.</p>
        <p>Na área do aluno, autenticação, práticas, voz, transcrições, feedback e uso de minutos seguem a finalidade educacional e os termos da matrícula.</p>
      </Section>
      <Section title="Prazo e armazenamento">
        <p>O progresso anônimo do quiz fica somente neste navegador por até {WOLFIE_QUIZ_RETENTION_DAYS} dias. O resultado fica na sessão da aba e é removido ao refazer o quiz ou depois de ser levado ao primeiro treino autenticado.</p>
        <p>Se o contato não se converter em relação de aluno ou cliente, o prazo padrão do registro é de até {WOLFIE_LEAD_RETENTION_DAYS} dias após o último contato, salvo obrigação legal, exercício regular de direitos ou pedido de exclusão anterior.</p>
      </Section>
      <Section title="Compartilhamento e segurança">
        <p>Dados são acessados apenas por pessoas e fornecedores necessários à operação, autenticação, comunicação e recursos de IA, sob controles de acesso. Não vendemos respostas, áudio ou transcrições e não os enviamos a pixels de publicidade neste funil.</p>
      </Section>
      <Section title="Seus direitos">
        <p>Você pode pedir confirmação, acesso, correção, informação sobre uso, revogação do consentimento e exclusão quando aplicável. Revogar o contato comercial não afeta o uso anterior realizado de forma válida.</p>
      </Section>
    </LegalLayout>
  );
}

export function TermsPage() {
  return (
    <LegalLayout eyebrow="Termos de uso" title="Uso responsável do Wolfie">
      <Section title="Diagnóstico público">
        <p>O resultado organiza um ponto de partida a partir das respostas declaradas. Ele não garante proficiência, desempenho profissional, aprovação em entrevista ou qualquer resultado específico.</p>
      </Section>
      <Section title="Acesso à prática">
        <p>A prática completa exige uma conta de aluno ativa e está sujeita às condições da matrícula, disponibilidade técnica, limites do plano e regras de uso da Wise Wolf. O formulário público não cria conta nem cobrança.</p>
      </Section>
      <Section title="Uso permitido">
        <p>Não tente contornar autenticação, cotas, isolamento entre contas ou limites de segurança; automatizar abuso do serviço; inserir dados de terceiros sem autorização; ou usar o Wolfie para conteúdo ilegal ou que viole direitos.</p>
      </Section>
      <Section title="IA e responsabilidade do aluno">
        <p>Respostas e correções de IA podem conter imprecisões. Revise informações importantes e não compartilhe segredos, dados sensíveis ou conteúdo confidencial de reuniões reais durante a prática.</p>
      </Section>
      <Section title="Atualizações">
        <p>Podemos atualizar estes termos para refletir mudanças do produto ou requisitos legais. A versão e a data vigentes ficam visíveis nesta página.</p>
      </Section>
    </LegalLayout>
  );
}
