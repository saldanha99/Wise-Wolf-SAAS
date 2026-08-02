import type { LearningUniverseId } from "../experienceCatalog";
import type { WolfieExperienceMode } from "../types";
import type {
  WolfieVisualAssetSet,
  WolfieVisualPalette,
  WolfieVisualScenarioProfile,
  WolfieVisualSceneProfile,
  WolfieVisualSectorId,
} from "./types";

export const WOLFIE_UNIVERSE_PALETTES: Record<
  LearningUniverseId,
  WolfieVisualPalette
> = {
  "about-you": {
    accent: "#F5B94C",
    glow: "rgba(245, 185, 76, 0.28)",
    scrim: "rgba(21, 27, 45, 0.72)",
    gradient: "linear-gradient(145deg, #17233f 0%, #382b45 52%, #8a533d 100%)",
  },
  "daily-life": {
    accent: "#58D6BC",
    glow: "rgba(88, 214, 188, 0.24)",
    scrim: "rgba(12, 34, 40, 0.72)",
    gradient: "linear-gradient(145deg, #123940 0%, #1f5e62 48%, #b2764d 100%)",
  },
  speaking: {
    accent: "#FF7B72",
    glow: "rgba(255, 123, 114, 0.28)",
    scrim: "rgba(28, 18, 42, 0.72)",
    gradient: "linear-gradient(145deg, #211735 0%, #663e69 50%, #d96665 100%)",
  },
  "kids-teens": {
    accent: "#FFD84D",
    glow: "rgba(255, 216, 77, 0.3)",
    scrim: "rgba(26, 31, 63, 0.68)",
    gradient: "linear-gradient(145deg, #283565 0%, #6056a5 45%, #48a7c8 100%)",
  },
  career: {
    accent: "#65B7FF",
    glow: "rgba(101, 183, 255, 0.25)",
    scrim: "rgba(10, 25, 48, 0.76)",
    gradient: "linear-gradient(145deg, #0d203d 0%, #244d76 52%, #527da1 100%)",
  },
  "global-meetings": {
    accent: "#59D3FF",
    glow: "rgba(89, 211, 255, 0.25)",
    scrim: "rgba(5, 18, 35, 0.78)",
    gradient: "linear-gradient(145deg, #061629 0%, #123d5d 52%, #236f83 100%)",
  },
  events: {
    accent: "#C8A7FF",
    glow: "rgba(200, 167, 255, 0.27)",
    scrim: "rgba(26, 17, 47, 0.74)",
    gradient: "linear-gradient(145deg, #211635 0%, #5d3f73 50%, #b16d85 100%)",
  },
  "international-exams": {
    accent: "#85A6FF",
    glow: "rgba(133, 166, 255, 0.22)",
    scrim: "rgba(18, 27, 47, 0.8)",
    gradient: "linear-gradient(145deg, #151e33 0%, #354a6c 52%, #657589 100%)",
  },
  "skill-labs": {
    accent: "#6EE7FF",
    glow: "rgba(110, 231, 255, 0.26)",
    scrim: "rgba(8, 25, 39, 0.76)",
    gradient: "linear-gradient(145deg, #081c2c 0%, #174f62 50%, #58768a 100%)",
  },
};

const GENERATED_SCENE_IDS = new Set([
  "meetings-business",
  "meetings-medicine",
  "meetings-human-reproduction",
  "meetings-laboratories",
  "meetings-beauty",
  "meetings-retail",
  "meetings-technology",
  "meetings-logistics",
  "meetings-tourism",
  "meetings-aviation",
  "food-cooking",
  "speak-for-a-minute",
]);

const createGeneratedAssetSet = (
  universeId: LearningUniverseId,
  experienceId: string,
): WolfieVisualAssetSet | undefined => {
  if (!GENERATED_SCENE_IDS.has(experienceId)) return undefined;

  return {
    desktopWebp: `/assets/wolfie/scenes/${universeId}/${experienceId}/desktop.webp`,
    mobileWebp: `/assets/wolfie/scenes/${universeId}/${experienceId}/mobile.webp`,
  };
};

type ScenarioDefinition = Omit<
  WolfieVisualScenarioProfile,
  "version" | "key" | "palette" | "assets"
>;

const scenario = (
  input: ScenarioDefinition,
): WolfieVisualScenarioProfile => {
  const assets = createGeneratedAssetSet(input.universeId, input.experienceId);
  return {
    ...input,
    version: 1,
    key: `experience:${input.experienceId}`,
    palette: WOLFIE_UNIVERSE_PALETTES[input.universeId],
    ...(assets ? { assets } : {}),
  };
};

/**
 * Canonical visual manifest. Every pedagogical experience is intentionally
 * declared here instead of being inferred from titles or learner-authored text.
 */
export const WOLFIE_SCENE_CATALOG: readonly WolfieVisualScenarioProfile[] = [
  scenario({
    experienceId: "introduce-yourself",
    universeId: "about-you",
    experienceMode: "guided_lesson",
    layout: "conversation",
    environmentId: "personal-introduction-studio",
    environmentDescription:
      "Estúdio acolhedor de apresentação com luz suave de manhã e fundo premium.",
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Estúdio acolhedor para praticar apresentações.",
  }),
  scenario({
    experienceId: "my-routine",
    universeId: "about-you",
    experienceMode: "storytelling",
    layout: "conversation",
    environmentId: "daily-routine-apartment",
    environmentDescription:
      "Apartamento contemporâneo com sinais sutis de manhã e fim do dia.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Apartamento com objetos que representam uma rotina diária.",
  }),
  scenario({
    experienceId: "my-home",
    universeId: "about-you",
    experienceMode: "vocabulary",
    layout: "lab",
    environmentId: "contemporary-home-observation",
    environmentDescription:
      "Sala contemporânea com pontos de interesse visuais e objetos domésticos.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Sala contemporânea preparada para descrever espaços e objetos.",
  }),
  scenario({
    experienceId: "my-family",
    universeId: "about-you",
    experienceMode: "storytelling",
    layout: "conversation",
    environmentId: "family-memory-lounge",
    environmentDescription:
      "Lounge íntimo com porta-retratos abstratos e álbum fechado, sem pessoas reais.",
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Lounge tranquilo para contar histórias sobre a família.",
  }),
  scenario({
    experienceId: "my-childhood",
    universeId: "about-you",
    experienceMode: "storytelling",
    layout: "conversation",
    environmentId: "childhood-memory-attic",
    environmentDescription:
      "Estúdio de memórias com brinquedos genéricos e luz nostálgica.",
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Espaço de memórias para narrar acontecimentos da infância.",
  }),
  scenario({
    experienceId: "my-plans",
    universeId: "about-you",
    experienceMode: "guided_lesson",
    layout: "conversation",
    environmentId: "future-planning-desk",
    environmentDescription:
      "Mesa de planejamento diante de uma janela para o horizonte.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Mesa de planejamento com horizonte ao fundo.",
  }),

  scenario({
    experienceId: "home-organization",
    universeId: "daily-life",
    experienceMode: "vocabulary",
    layout: "lab",
    environmentId: "home-organization-workspace",
    environmentDescription:
      "Apartamento funcional com itens domésticos preparados para organizar.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Apartamento funcional para praticar organização da casa.",
  }),
  scenario({
    experienceId: "food-cooking",
    universeId: "daily-life",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "contemporary-cooking-kitchen",
    environmentDescription:
      "Cozinha contemporânea com bancada limpa e ingredientes sem marcas.",
    castIds: ["service-counterpart"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Cozinha contemporânea para explicar receitas e escolhas alimentares.",
  }),
  scenario({
    experienceId: "skincare-beauty",
    universeId: "daily-life",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "beauty-product-showroom",
    environmentDescription:
      "Estúdio de beleza com bancada limpa e embalagens genéricas sem marcas.",
    castIds: ["service-counterpart"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Showroom de beleza para comparar e recomendar produtos.",
  }),
  scenario({
    experienceId: "health-symptoms",
    universeId: "daily-life",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "welcoming-health-consultation",
    environmentDescription:
      "Consultório acolhedor e não hospitalar, sem prontuários ou dados clínicos.",
    castIds: ["clinical-peer"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Consultório acolhedor para praticar a descrição de sintomas.",
  }),
  scenario({
    experienceId: "shopping",
    universeId: "daily-life",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "modern-retail-store",
    environmentDescription:
      "Loja moderna com balcão, araras genéricas e espaço para opções acessíveis.",
    castIds: ["service-counterpart"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Loja moderna para perguntar, comparar e resolver compras.",
  }),
  scenario({
    experienceId: "services",
    universeId: "daily-life",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "service-desk",
    environmentDescription:
      "Balcão flexível de hotel e atendimento em composição frente a frente.",
    castIds: ["service-counterpart"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Balcão de atendimento para solicitar e confirmar serviços.",
  }),
  scenario({
    experienceId: "digital-life",
    universeId: "daily-life",
    experienceMode: "guided_lesson",
    layout: "conversation",
    environmentId: "safe-digital-home-office",
    environmentDescription:
      "Home office com dispositivos e painéis abstratos sem conteúdo privado legível.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Home office para conversar sobre ferramentas e vida digital.",
  }),

  scenario({
    experienceId: "record-a-story",
    universeId: "speaking",
    experienceMode: "storytelling",
    layout: "presentation",
    environmentId: "vertical-creator-studio",
    environmentDescription:
      "Estúdio vertical de creator com iluminação suave e enquadramento abstrato.",
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Estúdio vertical para gravar uma história curta.",
  }),
  scenario({
    experienceId: "tell-a-story",
    universeId: "speaking",
    experienceMode: "storytelling",
    layout: "presentation",
    environmentId: "cinematic-story-stage",
    environmentDescription:
      "Pequeno palco cinematográfico com profundidade e foco na narrativa.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Palco cinematográfico para estruturar e contar uma história.",
  }),
  scenario({
    experienceId: "describe-what-you-see",
    universeId: "speaking",
    experienceMode: "vocabulary",
    layout: "lab",
    environmentId: "observation-gallery",
    environmentDescription:
      "Galeria de observação com moldura vazia para conteúdo dinâmico acessível.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Galeria de observação para descrever uma imagem ou objeto.",
  }),
  scenario({
    experienceId: "give-your-opinion",
    universeId: "speaking",
    experienceMode: "free_conversation",
    layout: "conversation",
    environmentId: "opinion-podcast-lounge",
    environmentDescription:
      "Lounge de podcast original, confortável e sem marcas.",
    castIds: ["wolfie-coach"],
    camera: "close",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Lounge de conversa para expressar e sustentar opiniões.",
  }),
  scenario({
    experienceId: "speak-for-a-minute",
    universeId: "speaking",
    experienceMode: "fluency",
    layout: "presentation",
    environmentId: "one-minute-speaking-studio",
    environmentDescription:
      "Microestúdio com spotlight e espaço limpo para um cronômetro acessível.",
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Estúdio de fala para sustentar uma ideia por um minuto.",
  }),

  scenario({
    experienceId: "game-worlds",
    universeId: "kids-teens",
    experienceMode: "child_mission",
    layout: "mission",
    environmentId: "original-adventure-world",
    environmentDescription:
      "Mundo de aventura 3D original com caminhos e mapa de missão.",
    castIds: ["wolfie-coach", "youth-guide"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "mission",
    accessibleEnvironmentLabel: "Mundo de aventura seguro com uma missão para completar.",
  }),
  scenario({
    experienceId: "roblox-inspired-missions",
    universeId: "kids-teens",
    experienceMode: "child_mission",
    layout: "mission",
    environmentId: "original-modular-block-world",
    environmentDescription:
      "Mundo modular de blocos totalmente original, sem logos ou interfaces de jogos.",
    castIds: ["wolfie-coach", "youth-guide"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "mission",
    accessibleEnvironmentLabel: "Mundo modular original com obstáculos e escolhas de missão.",
  }),
  scenario({
    experienceId: "create-your-avatar",
    universeId: "kids-teens",
    experienceMode: "child_mission",
    layout: "mission",
    environmentId: "character-creation-workshop",
    environmentDescription:
      "Oficina inclusiva de criação de personagem com módulos abstratos.",
    castIds: ["wolfie-coach", "youth-guide"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "mission",
    accessibleEnvironmentLabel: "Oficina para descrever e criar um personagem original.",
  }),
  scenario({
    experienceId: "school-life",
    universeId: "kids-teens",
    experienceMode: "teen_challenge",
    layout: "mission",
    environmentId: "contemporary-school-common-area",
    environmentDescription:
      "Espaço comum de escola contemporânea com personagens de fundo não identificáveis.",
    castIds: ["youth-guide"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "mission",
    accessibleEnvironmentLabel: "Espaço escolar contemporâneo para resolver situações do dia a dia.",
  }),
  scenario({
    experienceId: "series-characters",
    universeId: "kids-teens",
    experienceMode: "teen_challenge",
    layout: "mission",
    environmentId: "original-story-screenplay-studio",
    environmentDescription:
      "Estúdio fictício de roteiro e cinema com silhuetas totalmente originais.",
    castIds: ["youth-guide"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "mission",
    accessibleEnvironmentLabel: "Estúdio de histórias para conversar sobre personagens e enredos.",
  }),
  scenario({
    experienceId: "mystery-adventures",
    universeId: "kids-teens",
    experienceMode: "child_mission",
    layout: "mission",
    environmentId: "light-mystery-room",
    environmentDescription:
      "Sala de investigação leve com pistas claras e atmosfera não assustadora.",
    castIds: ["wolfie-coach", "youth-guide"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "mission",
    accessibleEnvironmentLabel: "Sala de mistério segura com pistas para investigar.",
  }),

  scenario({
    experienceId: "job-interviews",
    universeId: "career",
    experienceMode: "interview",
    layout: "interview",
    environmentId: "contemporary-interview-room",
    environmentDescription:
      "Sala contemporânea de entrevista com composição frente a frente.",
    castIds: ["interviewer"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Sala profissional para simular uma entrevista de emprego.",
  }),
  scenario({
    experienceId: "first-job",
    universeId: "career",
    experienceMode: "interview",
    layout: "interview",
    environmentId: "first-job-onboarding-station",
    environmentDescription:
      "Estação de onboarding em escritório com ambiente acolhedor.",
    castIds: ["interviewer"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Estação de integração para praticar conversas do primeiro emprego.",
  }),
  scenario({
    experienceId: "multinationals",
    universeId: "career",
    sector: "projects_operations",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "hybrid-multinational-office",
    environmentDescription:
      "Escritório híbrido global com videowall abstrato e elenco diverso.",
    castIds: ["executive-counterpart", "technical-stakeholder"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Escritório híbrido para colaborar com uma equipe multinacional.",
  }),
  scenario({
    experienceId: "promotion",
    universeId: "career",
    experienceMode: "interview",
    layout: "interview",
    environmentId: "leadership-development-room",
    environmentDescription:
      "Sala reservada de desenvolvimento profissional e liderança.",
    castIds: ["executive-counterpart"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Sala de liderança para apresentar resultados e discutir promoção.",
  }),
  scenario({
    experienceId: "career-networking",
    universeId: "career",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "professional-networking-lounge",
    environmentDescription:
      "Lounge de evento profissional com pequenos grupos desfocados ao fundo.",
    castIds: ["executive-counterpart"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Lounge profissional para praticar networking.",
  }),
  scenario({
    experienceId: "career-change",
    universeId: "career",
    experienceMode: "interview",
    layout: "interview",
    environmentId: "career-strategy-studio",
    environmentDescription:
      "Estúdio de estratégia de carreira com caminhos visuais abstratos.",
    castIds: ["interviewer", "wolfie-coach"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Estúdio de estratégia para explicar uma mudança de carreira.",
  }),

  scenario({
    experienceId: "meetings-business",
    universeId: "global-meetings",
    sector: "projects_operations",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "international-business-boardroom",
    environmentDescription:
      "Boardroom internacional com painel de indicadores abstrato e área de decisão.",
    castIds: ["executive-counterpart"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala internacional de negócios para discutir decisões e próximos passos.",
  }),
  scenario({
    experienceId: "meetings-medicine",
    universeId: "global-meetings",
    sector: "pharma_health",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "international-clinical-discussion-room",
    environmentDescription:
      "Sala internacional de discussão clínica sem nomes ou dados de pacientes.",
    castIds: ["clinical-peer"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala clínica internacional para discutir informações médicas.",
  }),
  scenario({
    experienceId: "meetings-human-reproduction",
    universeId: "global-meetings",
    sector: "pharma_health",
    experienceMode: "presentation",
    layout: "presentation",
    environmentId: "human-reproduction-roundtable",
    environmentDescription:
      "Mesa-redonda científica multidisciplinar, técnica e acolhedora.",
    castIds: ["clinical-peer", "technical-stakeholder"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Mesa-redonda multidisciplinar de reprodução humana.",
  }),
  scenario({
    experienceId: "meetings-laboratories",
    universeId: "global-meetings",
    sector: "pharma_health",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "laboratory-quality-room",
    environmentDescription:
      "Sala de qualidade próxima a laboratório com equipamentos abstratos ao fundo.",
    castIds: ["technical-stakeholder"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala de qualidade para discutir processos e resultados laboratoriais.",
  }),
  scenario({
    experienceId: "meetings-beauty",
    universeId: "global-meetings",
    sector: "beauty_cosmetics_perfumery",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "beauty-launch-showroom",
    environmentDescription:
      "Showroom de lançamento e distribuição com amostras sem marcas reais.",
    castIds: ["executive-counterpart", "service-counterpart"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Showroom profissional para alinhar lançamento de produtos de beleza.",
  }),
  scenario({
    experienceId: "meetings-retail",
    universeId: "global-meetings",
    sector: "retail_wholesale",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "retail-merchandising-room",
    environmentDescription:
      "Sala de merchandising e performance de categoria com planogramas abstratos.",
    castIds: ["executive-counterpart"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala de varejo para discutir margem, estoque e canais.",
  }),
  scenario({
    experienceId: "meetings-technology",
    universeId: "global-meetings",
    sector: "technology_ai",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "technology-product-war-room",
    environmentDescription:
      "Sala de produto e incidentes com quadros técnicos abstratos.",
    castIds: ["technical-stakeholder"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala de tecnologia para alinhar produto, dados e incidentes.",
  }),
  scenario({
    experienceId: "meetings-logistics",
    universeId: "global-meetings",
    sector: "logistics",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "logistics-control-tower",
    environmentDescription:
      "Control tower com rotas e operações abstratas, sem localizações reais.",
    castIds: ["technical-stakeholder", "service-counterpart"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Central logística para discutir riscos, rotas e fornecedores.",
  }),
  scenario({
    experienceId: "meetings-tourism",
    universeId: "global-meetings",
    sector: "tourism_hospitality",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "hospitality-operations-room",
    environmentDescription:
      "Sala de operações de hospitalidade e parceiros com atmosfera relacional.",
    castIds: ["service-counterpart"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala de hospitalidade para alinhar operações e parceiros turísticos.",
  }),
  scenario({
    experienceId: "meetings-aviation",
    universeId: "global-meetings",
    sector: "tourism_hospitality",
    experienceMode: "global_meeting",
    layout: "meeting",
    environmentId: "aviation-operations-briefing",
    environmentDescription:
      "Briefing operacional de aeroporto com painéis sem voos ou dados reais.",
    castIds: ["technical-stakeholder"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "meeting",
    accessibleEnvironmentLabel: "Sala de briefing de aviação para discutir operação e segurança.",
  }),

  scenario({
    experienceId: "events-networking",
    universeId: "events",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "conference-networking-area",
    environmentDescription:
      "Área de networking de conferência com grupos desfocados ao fundo.",
    castIds: ["executive-counterpart"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Área de conferência para iniciar e encerrar conversas profissionais.",
  }),
  scenario({
    experienceId: "medical-congresses",
    universeId: "events",
    sector: "pharma_health",
    experienceMode: "presentation",
    layout: "presentation",
    environmentId: "medical-congress-hall",
    environmentDescription:
      "Corredor e sala de congresso médico sem dados clínicos ou marcas.",
    castIds: ["clinical-peer"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Congresso médico para apresentar uma área e discutir pesquisa.",
  }),
  scenario({
    experienceId: "talks",
    universeId: "events",
    sector: "projects_operations",
    experienceMode: "presentation",
    layout: "presentation",
    environmentId: "conference-talk-stage",
    environmentDescription:
      "Palco de palestra com plateia abstrata e tela sem conteúdo legível.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Palco de conferência para praticar uma palestra.",
  }),
  scenario({
    experienceId: "panels",
    universeId: "events",
    experienceMode: "presentation",
    layout: "presentation",
    environmentId: "conference-panel-stage",
    environmentDescription:
      "Palco amplo com cadeiras de painel e iluminação profissional.",
    castIds: ["executive-counterpart", "technical-stakeholder"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Palco de painel para comparar e complementar ideias.",
  }),
  scenario({
    experienceId: "trade-shows",
    universeId: "events",
    experienceMode: "roleplay",
    layout: "roleplay",
    environmentId: "generic-trade-show-booth",
    environmentDescription:
      "Estande profissional genérico sem logos, nomes ou produtos protegidos.",
    castIds: ["executive-counterpart"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "conversation",
    accessibleEnvironmentLabel: "Estande de feira para apresentar produtos e conversar com visitantes.",
  }),
  scenario({
    experienceId: "poster-presentation",
    universeId: "events",
    sector: "pharma_health",
    experienceMode: "presentation",
    layout: "presentation",
    environmentId: "academic-poster-area",
    environmentDescription:
      "Área acadêmica de pôster com suporte visual vazio para conteúdo acessível separado.",
    castIds: ["clinical-peer"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Área acadêmica para apresentar um pôster e responder perguntas.",
  }),

  scenario({
    experienceId: "exam-cambridge",
    universeId: "international-exams",
    experienceMode: "exam",
    layout: "exam",
    environmentId: "classic-paired-speaking-room",
    environmentDescription:
      "Sala oral clássica e sóbria, sem marcas oficiais ou materiais protegidos.",
    castIds: ["examiner"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "exam",
    accessibleEnvironmentLabel: "Sala sóbria para simular tarefas orais em dupla.",
  }),
  scenario({
    experienceId: "exam-toefl",
    universeId: "international-exams",
    experienceMode: "exam",
    layout: "exam",
    environmentId: "academic-computer-test-booth",
    environmentDescription:
      "Cabine moderna de prova por computador com microfone e superfície limpa.",
    castIds: ["examiner"],
    camera: "medium",
    characterSide: "left",
    hudVariant: "exam",
    accessibleEnvironmentLabel: "Cabine de prova para praticar tarefas acadêmicas integradas.",
  }),
  scenario({
    experienceId: "exam-ielts",
    universeId: "international-exams",
    experienceMode: "exam",
    layout: "exam",
    environmentId: "individual-speaking-exam-room",
    environmentDescription:
      "Sala individual de speaking com examinador em frente ao aluno.",
    castIds: ["examiner"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "exam",
    accessibleEnvironmentLabel: "Sala individual para praticar uma entrevista oral de exame.",
  }),
  scenario({
    experienceId: "exam-toeic",
    universeId: "international-exams",
    experienceMode: "exam",
    layout: "exam",
    environmentId: "corporate-assessment-center",
    environmentDescription:
      "Centro de avaliação corporativa com contexto profissional abstrato.",
    castIds: ["examiner"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "exam",
    accessibleEnvironmentLabel: "Centro de avaliação para praticar comunicação profissional sob tempo.",
  }),
  scenario({
    experienceId: "exam-duolingo",
    universeId: "international-exams",
    experienceMode: "exam",
    layout: "exam",
    environmentId: "remote-adaptive-test-desk",
    environmentDescription:
      "Mesa neutra de prova remota com webcam, sem identidade visual proprietária.",
    castIds: ["examiner"],
    camera: "close",
    characterSide: "left",
    hudVariant: "exam",
    accessibleEnvironmentLabel: "Mesa de prova remota para praticar respostas rápidas.",
  }),

  scenario({
    experienceId: "listening-lab",
    universeId: "skill-labs",
    experienceMode: "guided_lesson",
    layout: "lab",
    environmentId: "spatial-listening-booth",
    environmentDescription:
      "Cabine acústica com fontes sonoras espaciais e ondas apenas decorativas.",
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "right",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Cabine acústica para praticar compreensão oral.",
  }),
  scenario({
    experienceId: "pronunciation-lab",
    universeId: "skill-labs",
    experienceMode: "pronunciation",
    layout: "lab",
    environmentId: "reactive-voice-studio",
    environmentDescription:
      "Estúdio de voz com microfone e iluminação reativa discreta.",
    castIds: ["wolfie-coach"],
    camera: "close",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Estúdio de voz para praticar clareza, ritmo e pronúncia.",
  }),
  scenario({
    experienceId: "writing-lab",
    universeId: "skill-labs",
    experienceMode: "writing",
    layout: "writing",
    environmentId: "minimal-editorial-station",
    environmentDescription:
      "Estação editorial minimalista com o documento como foco principal.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Estação editorial para escrever, revisar e reformular textos.",
  }),
  scenario({
    experienceId: "vocabulary-lab",
    universeId: "skill-labs",
    experienceMode: "vocabulary",
    layout: "lab",
    environmentId: "context-object-lab",
    environmentDescription:
      "Mesa de objetos e contextos com módulos visuais sem texto incorporado.",
    castIds: ["wolfie-coach"],
    camera: "wide",
    characterSide: "left",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Laboratório de objetos e contextos para praticar vocabulário.",
  }),
  scenario({
    experienceId: "presentation-lab",
    universeId: "skill-labs",
    sector: "projects_operations",
    experienceMode: "presentation",
    layout: "presentation",
    environmentId: "presentation-rehearsal-stage",
    environmentDescription:
      "Palco de ensaio com tela abstrata e espaço para perguntas acessíveis.",
    castIds: ["wolfie-coach", "executive-counterpart"],
    camera: "wide",
    characterSide: "right",
    hudVariant: "studio",
    accessibleEnvironmentLabel: "Palco de ensaio para estruturar e praticar apresentações.",
  }),
];

export const SCENE_CATALOG = WOLFIE_SCENE_CATALOG;

export const WOLFIE_SCENE_BY_EXPERIENCE_ID: Readonly<
  Record<string, WolfieVisualScenarioProfile>
> = Object.freeze(
  Object.fromEntries(
    WOLFIE_SCENE_CATALOG.map((profile) => [profile.experienceId, profile]),
  ),
);

type FallbackDefinition = Omit<
  WolfieVisualSceneProfile,
  "version" | "assets"
>;

const fallback = (input: FallbackDefinition): WolfieVisualSceneProfile => ({
  ...input,
  version: 1,
});

const neutralPalette: WolfieVisualPalette = {
  accent: "#8CD7FF",
  glow: "rgba(140, 215, 255, 0.24)",
  scrim: "rgba(9, 20, 39, 0.8)",
  gradient: "linear-gradient(145deg, #09172c 0%, #193753 52%, #325a70 100%)",
};

const sectorFallback = (
  sector: WolfieVisualSectorId,
  environmentDescription: string,
  accessibleEnvironmentLabel: string,
  castIds: readonly string[],
): WolfieVisualSceneProfile =>
  fallback({
    key: `sector:${sector}`,
    sector,
    layout: "meeting",
    environmentId: `sector-${sector}`,
    environmentDescription,
    castIds,
    camera: "wide",
    characterSide: "right",
    palette: WOLFIE_UNIVERSE_PALETTES["global-meetings"],
    hudVariant: "meeting",
    accessibleEnvironmentLabel,
  });

export const WOLFIE_SECTOR_FALLBACKS: Readonly<
  Record<WolfieVisualSectorId, WolfieVisualSceneProfile>
> = {
  pharma_health: sectorFallback(
    "pharma_health",
    "Sala internacional de saúde e qualidade sem dados clínicos.",
    "Sala profissional de saúde para uma reunião internacional.",
    ["clinical-peer"],
  ),
  manufacturing_foundry: sectorFallback(
    "manufacturing_foundry",
    "Sala de operações industriais com linha de produção abstrata.",
    "Sala industrial para discutir produção, segurança e qualidade.",
    ["technical-stakeholder"],
  ),
  banking_finance: sectorFallback(
    "banking_finance",
    "Sala financeira sóbria com indicadores e gráficos abstratos.",
    "Sala financeira para discutir risco, governança e resultados.",
    ["executive-counterpart"],
  ),
  technology_ai: sectorFallback(
    "technology_ai",
    "Sala de produto e tecnologia com painéis abstratos.",
    "Sala de tecnologia para alinhamento entre equipes.",
    ["technical-stakeholder"],
  ),
  logistics: sectorFallback(
    "logistics",
    "Central de logística com rotas e operações abstratas.",
    "Central logística para discutir prazos, fornecedores e continuidade.",
    ["technical-stakeholder"],
  ),
  information_technology: sectorFallback(
    "information_technology",
    "Sala de infraestrutura e suporte com sistemas abstratos.",
    "Sala de TI para discutir projetos, suporte e segurança.",
    ["technical-stakeholder"],
  ),
  tax: sectorFallback(
    "tax",
    "Sala de auditoria e conformidade com documentos abstratos.",
    "Sala fiscal para discutir prazos, auditoria e impactos tributários.",
    ["executive-counterpart"],
  ),
  beauty_cosmetics_perfumery: sectorFallback(
    "beauty_cosmetics_perfumery",
    "Showroom profissional de beleza com produtos sem marcas.",
    "Showroom para discutir produtos, lançamentos e distribuição.",
    ["service-counterpart"],
  ),
  retail_wholesale: sectorFallback(
    "retail_wholesale",
    "Sala de merchandising com prateleiras e indicadores abstratos.",
    "Sala de varejo para discutir compras, estoque e canais.",
    ["executive-counterpart"],
  ),
  food_beverage: sectorFallback(
    "food_beverage",
    "Showroom de alimentos e bebidas com embalagens genéricas.",
    "Showroom para discutir portfólio, embalagem e entrada em mercado.",
    ["service-counterpart"],
  ),
  veterinary_pet: sectorFallback(
    "veterinary_pet",
    "Sala técnica de saúde animal sem pacientes ou marcas.",
    "Sala profissional para discutir saúde animal e parcerias.",
    ["clinical-peer"],
  ),
  tourism_hospitality: sectorFallback(
    "tourism_hospitality",
    "Sala de operações de hospitalidade e parceiros.",
    "Sala de hospitalidade para discutir hóspedes, reservas e parceiros.",
    ["service-counterpart"],
  ),
  sales_expansion: sectorFallback(
    "sales_expansion",
    "Sala comercial internacional com mapa abstrato de expansão.",
    "Sala comercial para discutir pitch, negociação e expansão.",
    ["executive-counterpart"],
  ),
  projects_operations: sectorFallback(
    "projects_operations",
    "Boardroom de projetos com riscos e indicadores abstratos.",
    "Sala de projetos para discutir stakeholders, riscos e implantação.",
    ["executive-counterpart", "technical-stakeholder"],
  ),
};

const universeFallback = (
  universeId: LearningUniverseId,
  layout: WolfieVisualSceneProfile["layout"],
  hudVariant: WolfieVisualSceneProfile["hudVariant"],
  environmentDescription: string,
  accessibleEnvironmentLabel: string,
): WolfieVisualSceneProfile =>
  fallback({
    key: `universe:${universeId}`,
    universeId,
    layout,
    environmentId: `universe-${universeId}`,
    environmentDescription,
    castIds: ["wolfie-coach"],
    camera: "medium",
    characterSide: "left",
    palette: WOLFIE_UNIVERSE_PALETTES[universeId],
    hudVariant,
    accessibleEnvironmentLabel,
  });

export const WOLFIE_UNIVERSE_FALLBACKS: Readonly<
  Record<LearningUniverseId, WolfieVisualSceneProfile>
> = {
  "about-you": universeFallback(
    "about-you",
    "conversation",
    "conversation",
    "Estúdio pessoal acolhedor com objetos abstratos.",
    "Estúdio acolhedor para conversar sobre a vida do aluno.",
  ),
  "daily-life": universeFallback(
    "daily-life",
    "roleplay",
    "conversation",
    "Ambiente cotidiano contemporâneo e flexível.",
    "Ambiente cotidiano para praticar uma situação da vida real.",
  ),
  speaking: universeFallback(
    "speaking",
    "presentation",
    "studio",
    "Estúdio de fala com luz suave e espaço para feedback.",
    "Estúdio para praticar expressão oral.",
  ),
  "kids-teens": universeFallback(
    "kids-teens",
    "mission",
    "mission",
    "Mundo 3D original, seguro e lúdico com objetivo de missão.",
    "Mundo de aventura seguro para crianças e adolescentes.",
  ),
  career: universeFallback(
    "career",
    "interview",
    "conversation",
    "Ambiente profissional contemporâneo e acolhedor.",
    "Ambiente profissional para praticar situações de carreira.",
  ),
  "global-meetings": universeFallback(
    "global-meetings",
    "meeting",
    "meeting",
    "Sala híbrida internacional com painéis abstratos.",
    "Sala internacional para treinar uma reunião global.",
  ),
  events: universeFallback(
    "events",
    "presentation",
    "studio",
    "Espaço de conferência original com iluminação profissional.",
    "Espaço de evento para praticar networking e apresentações.",
  ),
  "international-exams": universeFallback(
    "international-exams",
    "exam",
    "exam",
    "Sala de prática de exame neutra e sem marcas oficiais.",
    "Sala neutra para praticar tarefas de exame internacional.",
  ),
  "skill-labs": universeFallback(
    "skill-labs",
    "lab",
    "studio",
    "Laboratório de habilidade com estações modulares.",
    "Laboratório para uma prática focada de inglês.",
  ),
};

const MODE_LAYOUTS: Record<
  WolfieExperienceMode,
  {
    layout: WolfieVisualSceneProfile["layout"];
    hudVariant: WolfieVisualSceneProfile["hudVariant"];
    label: string;
  }
> = {
  free_conversation: {
    layout: "conversation",
    hudVariant: "conversation",
    label: "conversa livre",
  },
  guided_lesson: {
    layout: "conversation",
    hudVariant: "conversation",
    label: "aula guiada",
  },
  roleplay: {
    layout: "roleplay",
    hudVariant: "conversation",
    label: "simulação de papéis",
  },
  presentation: {
    layout: "presentation",
    hudVariant: "studio",
    label: "apresentação",
  },
  global_meeting: {
    layout: "meeting",
    hudVariant: "meeting",
    label: "reunião global",
  },
  interview: {
    layout: "interview",
    hudVariant: "conversation",
    label: "entrevista",
  },
  exam: { layout: "exam", hudVariant: "exam", label: "exame" },
  writing: { layout: "writing", hudVariant: "studio", label: "escrita" },
  pronunciation: {
    layout: "lab",
    hudVariant: "studio",
    label: "pronúncia",
  },
  vocabulary: {
    layout: "lab",
    hudVariant: "studio",
    label: "vocabulário",
  },
  storytelling: {
    layout: "presentation",
    hudVariant: "studio",
    label: "narrativa",
  },
  child_mission: {
    layout: "mission",
    hudVariant: "mission",
    label: "missão infantil",
  },
  teen_challenge: {
    layout: "mission",
    hudVariant: "mission",
    label: "desafio adolescente",
  },
  examiner: { layout: "exam", hudVariant: "exam", label: "examinador" },
  fluency: {
    layout: "presentation",
    hudVariant: "studio",
    label: "fluência",
  },
  emergency: {
    layout: "roleplay",
    hudVariant: "conversation",
    label: "situação urgente",
  },
};

export const WOLFIE_MODE_FALLBACKS: Readonly<
  Record<WolfieExperienceMode, WolfieVisualSceneProfile>
> = Object.fromEntries(
  Object.entries(MODE_LAYOUTS).map(([experienceMode, definition]) => [
    experienceMode,
    fallback({
      key: `mode:${experienceMode}`,
      experienceMode: experienceMode as WolfieExperienceMode,
      layout: definition.layout,
      environmentId: `mode-${experienceMode}`,
      environmentDescription: `Estúdio neutro adaptado ao modo ${definition.label}.`,
      castIds: ["wolfie-coach"],
      camera: "medium",
      characterSide: "left",
      palette: neutralPalette,
      hudVariant: definition.hudVariant,
      accessibleEnvironmentLabel: `Estúdio neutro para ${definition.label}.`,
    }),
  ]),
) as Record<WolfieExperienceMode, WolfieVisualSceneProfile>;

export const WOLFIE_NEUTRAL_SCENE: WolfieVisualSceneProfile = fallback({
  key: "neutral",
  layout: "conversation",
  environmentId: "neutral-wolfie-studio",
  environmentDescription:
    "Estúdio Wise Wolf neutro com profundidade suave e espaço para a interface.",
  castIds: ["wolfie-coach"],
  camera: "medium",
  characterSide: "left",
  palette: neutralPalette,
  hudVariant: "conversation",
  accessibleEnvironmentLabel: "Estúdio neutro do Wolf Tutor.",
});
