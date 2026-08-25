export const HUB_CORE_TERMS_VERSION = "2026-08-24";
export const HUB_CORE_PRIVACY_VERSION = "2026-08-24";

export type HubCoreLegalDocumentKey = "terms" | "privacy";

export type HubCoreLegalSection = {
  id: string;
  title: string;
  paragraphs: readonly string[];
  items?: readonly string[];
};

export type HubCoreLegalDocument = {
  schema: "wise-wolf-hub-legal-document/v1";
  document: "TERMS_OF_USE" | "PRIVACY_POLICY";
  locale: "pt-BR";
  version: string;
  effectiveDate: string;
  effectiveDateLabel: string;
  eyebrow: string;
  title: string;
  summary: string;
  sections: readonly HubCoreLegalSection[];
};

const TERMS_DOCUMENT: HubCoreLegalDocument = {
  schema: "wise-wolf-hub-legal-document/v1",
  document: "TERMS_OF_USE",
  locale: "pt-BR",
  version: HUB_CORE_TERMS_VERSION,
  effectiveDate: "2026-08-24",
  effectiveDateLabel: "24 de agosto de 2026",
  eyebrow: "Relação transparente",
  title: "Termos de Uso do Wise Wolf Hub",
  summary:
    "Condições para contratar e usar as soluções com clareza sobre conta, cobrança, conteúdo e responsabilidades.",
  sections: [
    {
      id: "aceite",
      title: "1. Aceite e alcance",
      paragraphs: [
        "Estes Termos de Uso regem a contratação e o uso do Wise Wolf Hub, incluindo suas micro soluções, planos combinados, áreas autenticadas, conteúdos e recursos de inteligência artificial.",
        "Ao marcar o aceite no checkout, a pessoa declara que leu esta versão, possui capacidade para contratar em nome próprio ou da organização informada e concorda com estas condições. O aceite da Política de Privacidade é registrado separadamente e não representa autorização para marketing.",
      ],
    },
    {
      id: "conta",
      title: "2. Conta e responsabilidades",
      paragraphs: [
        "Cada conta possui ambiente, assinatura, permissões e dados próprios. O titular deve fornecer informações corretas, manter suas credenciais protegidas e limitar o acesso às pessoas autorizadas.",
        "Atividades realizadas por usuários autorizados são atribuídas à respectiva conta. Suspeitas de uso indevido devem ser comunicadas pelos canais oficiais exibidos na plataforma.",
      ],
    },
    {
      id: "solucoes",
      title: "3. Soluções e limites do plano",
      paragraphs: [
        "As funcionalidades disponíveis dependem do plano, ciclo, público elegível e limites apresentados no momento da contratação. Biblioteca, Educador IA, Wolfie e School OS podem ser oferecidos isoladamente ou em conjunto.",
        "Novos recursos podem ser incluídos, substituídos ou descontinuados para preservar segurança, qualidade pedagógica ou viabilidade técnica, sem retirar direitos já adquiridos durante o período pago em desacordo com a legislação aplicável.",
      ],
    },
    {
      id: "assinatura",
      title: "4. Assinatura, cobrança e cancelamento",
      paragraphs: [
        "Preço, periodicidade, tributos aplicáveis e forma de pagamento são exibidos antes da criação da cobrança. A liberação de recursos pagos ocorre somente depois da confirmação do provedor financeiro.",
        "Assinaturas recorrentes seguem o ciclo escolhido. Pedidos de cancelamento, arrependimento ou reembolso são tratados pelos canais disponibilizados no painel ou no suporte, observados o período contratado, a natureza do serviço e os direitos previstos na legislação brasileira.",
      ],
    },
    {
      id: "conteudo",
      title: "5. Licença de uso e propriedade intelectual",
      paragraphs: [
        "A assinatura concede licença limitada, revogável, não exclusiva e intransferível para uso das soluções durante a vigência do acesso. Marcas, interfaces, software, trilhas, materiais e demais ativos permanecem com seus respectivos titulares.",
      ],
      items: [
        "Não revender, sublicenciar, copiar em massa ou distribuir conteúdos fora das permissões do plano.",
        "Não remover avisos de autoria, licença ou proteção técnica.",
        "Não usar robôs, extração automatizada ou engenharia reversa para reproduzir o serviço.",
      ],
    },
    {
      id: "uso-adequado",
      title: "6. Uso adequado",
      paragraphs: [
        "É proibido usar o Hub para fraude, assédio, violação de direitos, envio de conteúdo malicioso, tentativa de acesso a outra conta, sobrecarga intencional ou qualquer finalidade ilegal.",
        "O acesso poderá ser limitado preventivamente quando houver risco relevante à segurança, indício de fraude, inadimplência ou violação destes Termos, com revisão proporcional ao risco e às obrigações legais.",
      ],
    },
    {
      id: "inteligencia-artificial",
      title: "7. Recursos de inteligência artificial",
      paragraphs: [
        "Respostas, planos e sugestões gerados por inteligência artificial servem como apoio. Eles podem conter imprecisões e devem ser revisados por uma pessoa qualificada antes de decisões pedagógicas, administrativas, financeiras ou jurídicas.",
        "A pessoa usuária não deve inserir segredos, dados excessivos ou informações de terceiros sem base legal e autorização adequadas.",
      ],
    },
    {
      id: "disponibilidade",
      title: "8. Disponibilidade e segurança",
      paragraphs: [
        "Aplicamos controles técnicos e organizacionais compatíveis com a natureza do serviço, incluindo isolamento lógico por conta e gestão de permissões. Interrupções podem ocorrer por manutenção, incidentes, serviços de terceiros ou eventos fora de controle razoável.",
        "Nenhum sistema é totalmente imune a falhas. Quando exigido, incidentes relevantes serão tratados e comunicados conforme a legislação aplicável.",
      ],
    },
    {
      id: "responsabilidade",
      title: "9. Responsabilidade",
      paragraphs: [
        "A Wise Wolf responde pelos deveres que a lei não permite excluir. Fora dessas hipóteses, cada parte responde por seus próprios atos, conteúdo, credenciais e decisões tomadas com base no uso do serviço.",
        "Links, integrações e serviços de terceiros possuem condições próprias. A indisponibilidade de um terceiro será tratada com diligência, sem transformar o Hub em garantidor irrestrito desse serviço externo.",
      ],
    },
    {
      id: "alteracoes",
      title: "10. Alterações, lei e contato",
      paragraphs: [
        "Mudanças relevantes geram uma nova versão e poderão exigir novo aceite. A versão aplicável à contratação fica registrada com data e vínculo à conta e ao usuário responsável.",
        "Estes Termos são regidos pelas leis brasileiras, preservados os foros e direitos obrigatórios do consumidor. Dúvidas e solicitações podem ser enviadas pelos canais oficiais informados no Wise Wolf Hub.",
      ],
    },
  ],
};

const PRIVACY_DOCUMENT: HubCoreLegalDocument = {
  schema: "wise-wolf-hub-legal-document/v1",
  document: "PRIVACY_POLICY",
  locale: "pt-BR",
  version: HUB_CORE_PRIVACY_VERSION,
  effectiveDate: "2026-08-24",
  effectiveDateLabel: "24 de agosto de 2026",
  eyebrow: "Privacidade por padrão",
  title: "Política de Privacidade do Wise Wolf Hub",
  summary:
    "Como tratamos dados pessoais, separamos ambientes e atendemos aos direitos previstos na LGPD.",
  sections: [
    {
      id: "papel",
      title: "1. Papel e abrangência",
      paragraphs: [
        "Esta Política explica como o Wise Wolf Hub trata dados pessoais em páginas públicas, cadastro, checkout, área autenticada, suporte e uso das soluções.",
        "Em recursos usados por uma escola ou professor para administrar dados de seus próprios alunos, essa organização ou profissional pode atuar como controlador, enquanto a Wise Wolf atua como operadora conforme as instruções e o contrato aplicável.",
      ],
    },
    {
      id: "dados",
      title: "2. Dados tratados",
      paragraphs: [
        "Tratamos apenas os dados necessários para disponibilizar, proteger e melhorar o serviço. As categorias podem incluir:",
      ],
      items: [
        "Cadastro e conta: nome, e-mail, telefone, perfil, vínculo e permissões.",
        "Contratação: CPF ou CNPJ, plano, ciclo, status e identificadores da cobrança. Dados bancários são processados pelo provedor de pagamento e não são armazenados pelo Hub.",
        "Uso pedagógico e operacional: preferências, materiais acessados, planos criados, interações e limites consumidos.",
        "Segurança e suporte: endereço de rede, dispositivo, registros técnicos, eventos de autenticação e comunicações de atendimento.",
        "Aceite legal: conta, usuário, versões aceitas, data e chave técnica da solicitação.",
      ],
    },
    {
      id: "finalidades",
      title: "3. Finalidades e bases legais",
      paragraphs: [
        "Os dados são usados para as seguintes finalidades, conforme a base legal adequada a cada situação:",
      ],
      items: [
        "Executar cadastro, assinatura, entrega, suporte e funcionalidades contratadas.",
        "Confirmar identidade, prevenir fraude, controlar acessos e proteger ambientes.",
        "Cumprir obrigações legais, fiscais, regulatórias e exercer direitos em processos.",
        "Medir desempenho e melhorar o produto com dados proporcionais e controles de segurança.",
        "Enviar comunicações transacionais da contratação e do serviço. Marketing depende de escolha separada quando aplicável.",
      ],
    },
    {
      id: "compartilhamento",
      title: "4. Compartilhamento e fornecedores",
      paragraphs: [
        "Dados podem ser compartilhados, no limite necessário, com provedores de pagamento, hospedagem, banco de dados, comunicação, monitoramento, suporte e inteligência artificial. Esses fornecedores recebem instruções, deveres de confidencialidade e controles compatíveis com sua função.",
        "Também poderemos compartilhar informações por obrigação legal, ordem válida ou para proteger direitos, pessoas e a integridade do serviço. Não vendemos dados pessoais.",
      ],
    },
    {
      id: "isolamento",
      title: "5. Isolamento e segurança",
      paragraphs: [
        "O Hub utiliza separação lógica por conta, controle por função, políticas de acesso no banco de dados, registros de eventos e outros mecanismos de defesa em profundidade. As permissões são verificadas no acesso aos recursos protegidos.",
        "A segurança também depende de senhas fortes, dispositivos atualizados e compartilhamento responsável de acessos pelo titular da conta.",
      ],
    },
    {
      id: "retencao",
      title: "6. Retenção e eliminação",
      paragraphs: [
        "Mantemos dados pelo período necessário para executar o serviço, cumprir obrigações, resolver disputas, prevenir fraude e exercer direitos. Após esse período, os dados são eliminados, anonimizados ou mantidos de forma restrita quando houver base legal.",
        "Registros de aceite e contratação podem ser preservados durante os prazos legais aplicáveis, mesmo após o encerramento da conta.",
      ],
    },
    {
      id: "direitos",
      title: "7. Direitos do titular",
      paragraphs: [
        "Nos termos da LGPD, a pessoa titular pode solicitar confirmação, acesso, correção, anonimização, bloqueio, eliminação quando cabível, portabilidade, informações sobre compartilhamento e revisão de decisões automatizadas aplicáveis.",
        "A solicitação poderá exigir validação de identidade. Quando outra escola ou professor for o controlador, encaminharemos a pessoa ao responsável adequado ou apoiaremos o atendimento conforme nossa função.",
      ],
    },
    {
      id: "transferencias",
      title: "8. Transferências internacionais",
      paragraphs: [
        "Alguns fornecedores podem processar dados em outros países. Nessas situações, adotamos mecanismos contratuais e medidas de segurança compatíveis com a LGPD e com a natureza do tratamento.",
      ],
    },
    {
      id: "cookies",
      title: "9. Cookies, menores e escolhas",
      paragraphs: [
        "Podemos usar armazenamento local e tecnologias essenciais para autenticação, segurança, preferências e funcionamento. Tecnologias não essenciais devem respeitar as escolhas apresentadas quando aplicável.",
        "Contas destinadas a menores devem ser administradas por responsáveis e instituições com a base legal e os cuidados exigidos. O Hub não deve ser usado para coletar dados excessivos de crianças ou adolescentes.",
      ],
    },
    {
      id: "atualizacoes",
      title: "10. Atualizações e contato",
      paragraphs: [
        "Alterações relevantes geram nova versão e poderão exigir novo aceite. A data vigente aparece no topo deste documento.",
        "Para exercer direitos ou esclarecer dúvidas de privacidade, use os canais oficiais exibidos na plataforma, identificando a conta relacionada e evitando enviar senhas ou dados bancários.",
      ],
    },
  ],
};

export const HUB_CORE_LEGAL_DOCUMENTS: Readonly<
  Record<HubCoreLegalDocumentKey, HubCoreLegalDocument>
> = Object.freeze({
  terms: TERMS_DOCUMENT,
  privacy: PRIVACY_DOCUMENT,
});

export const serializeHubCoreLegalDocument = (
  document: HubCoreLegalDocument,
): string => JSON.stringify(document);

export const HUB_CORE_TERMS_SNAPSHOT = serializeHubCoreLegalDocument(
  TERMS_DOCUMENT,
);
export const HUB_CORE_PRIVACY_SNAPSHOT = serializeHubCoreLegalDocument(
  PRIVACY_DOCUMENT,
);

export const HUB_CORE_TERMS_SHA256 =
  "ba35b46f3f13a31188c8a5c5b33fb0d02be7cc9a6415fe15d8d655056aa3bcdb";
export const HUB_CORE_PRIVACY_SHA256 =
  "84082bbc89500c91c9b661499149387bad9a3ce2c8b4f6b708449f3a002aacd7";

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const hubCoreLegalSnapshotsMatchExpectedHashes = async () => {
  const [termsSha256, privacySha256] = await Promise.all([
    sha256Hex(HUB_CORE_TERMS_SNAPSHOT),
    sha256Hex(HUB_CORE_PRIVACY_SNAPSHOT),
  ]);
  return termsSha256 === HUB_CORE_TERMS_SHA256 &&
    privacySha256 === HUB_CORE_PRIVACY_SHA256;
};
