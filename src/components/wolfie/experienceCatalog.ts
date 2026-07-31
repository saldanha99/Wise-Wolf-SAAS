import type { WolfieExperienceMode, WolfieSubject } from "./types";

export type ExperienceAudience =
  | "all"
  | "adult"
  | "kids"
  | "teens"
  | "professional";

export type ExperienceSkill =
  | "speaking"
  | "listening"
  | "writing"
  | "vocabulary"
  | "pronunciation"
  | "presentation"
  | "reading";

export type ExperienceModality = "voice" | "text" | "mixed";

export const LEARNING_UNIVERSE_IDS = [
  "about-you",
  "daily-life",
  "speaking",
  "kids-teens",
  "career",
  "global-meetings",
  "events",
  "international-exams",
  "skill-labs",
] as const;

export type LearningUniverseId = (typeof LEARNING_UNIVERSE_IDS)[number];

export interface LearningExperience {
  id: string;
  title: string;
  description: string;
  subject: WolfieSubject;
  sector?: string;
  experienceMode: WolfieExperienceMode;
  realWorldGoal: string;
  audiences: ExperienceAudience[];
  skills: ExperienceSkill[];
  durations: number[];
  modalities: ExperienceModality[];
  searchTerms: string[];
}

export interface LearningUniverse {
  id: LearningUniverseId;
  eyebrow: string;
  title: string;
  description: string;
  previewLimit: number;
  items: LearningExperience[];
}

export interface FeaturedExperience {
  experienceId: string;
  title: string;
  description: string;
  callToAction: string;
  metaLabel: string;
}

export interface ExperienceRecommendationProfile {
  role?: string;
  goal?: string;
  interests?: string | string[];
  audience?: ExperienceAudience;
  preferredModality?: ExperienceModality;
}

const experience = (
  input: LearningExperience,
): LearningExperience => input;

const personalDefaults = {
  subject: "grammar" as const,
  experienceMode: "free_conversation" as const,
  audiences: ["all", "adult", "teens"] as ExperienceAudience[],
  skills: ["speaking"] as ExperienceSkill[],
  durations: [3, 5, 10],
  modalities: ["voice", "text", "mixed"] as ExperienceModality[],
};

const professionalDefaults = {
  audiences: ["adult", "professional"] as ExperienceAudience[],
  durations: [5, 10, 15],
  modalities: ["voice", "text", "mixed"] as ExperienceModality[],
};

const examDefaults = {
  audiences: ["adult", "teens", "professional"] as ExperienceAudience[],
  durations: [5, 10, 15],
  modalities: ["voice", "text", "mixed"] as ExperienceModality[],
};

export const LEARNING_UNIVERSES: LearningUniverse[] = [
  {
    id: "about-you",
    eyebrow: "Comece por aqui",
    title: "Fale sobre sua vida",
    description:
      "Construa sua identidade em inglês a partir de histórias, pessoas e planos que já fazem parte de você.",
    previewLimit: 6,
    items: [
      experience({
        ...personalDefaults,
        id: "introduce-yourself",
        title: "Apresente-se",
        description: "Crie versões sociais, profissionais e espontâneas.",
        experienceMode: "guided_lesson",
        realWorldGoal:
          "Apresentar-se com clareza sem depender de um texto decorado.",
        searchTerms: ["introduce yourself", "apresentação", "sobre mim"],
      }),
      experience({
        ...personalDefaults,
        id: "my-routine",
        title: "Minha rotina",
        description: "Transforme seu dia em uma narrativa natural.",
        experienceMode: "storytelling",
        realWorldGoal:
          "Contar como é um dia comum e aprofundar detalhes da rotina.",
        searchTerms: ["hábitos", "dia a dia", "morning", "workday"],
      }),
      experience({
        ...personalDefaults,
        id: "my-home",
        title: "Minha casa",
        description: "Descreva espaços, objetos e a forma como você vive.",
        subject: "vocabulary",
        experienceMode: "vocabulary",
        realWorldGoal: "Descrever um ambiente e explicar onde as coisas estão.",
        skills: ["speaking", "vocabulary"],
        searchTerms: ["casa", "quarto", "cozinha", "objetos", "home"],
      }),
      experience({
        ...personalDefaults,
        id: "my-family",
        title: "Minha família",
        description: "Fale sobre relações, memórias e momentos importantes.",
        experienceMode: "storytelling",
        realWorldGoal:
          "Apresentar pessoas importantes e contar uma história sobre elas.",
        searchTerms: ["família", "relationships", "parents", "siblings"],
      }),
      experience({
        ...personalDefaults,
        id: "my-childhood",
        title: "Minha infância",
        description: "Conte lembranças usando passado e detalhes concretos.",
        experienceMode: "storytelling",
        realWorldGoal:
          "Contar uma memória de infância com começo, desenvolvimento e reflexão.",
        searchTerms: ["infância", "memória", "passado", "childhood"],
      }),
      experience({
        ...personalDefaults,
        id: "my-plans",
        title: "Meus planos",
        description: "Explique objetivos, decisões e próximos passos.",
        experienceMode: "guided_lesson",
        realWorldGoal:
          "Falar sobre planos futuros e explicar por que eles importam.",
        searchTerms: ["planos", "objetivos", "futuro", "goals"],
      }),
    ],
  },
  {
    id: "daily-life",
    eyebrow: "Inglês para a vida real",
    title: "Inglês do dia a dia",
    description:
      "Use objetos, tarefas e situações da sua rotina como matéria-prima para falar inglês.",
    previewLimit: 7,
    items: [
      experience({
        ...personalDefaults,
        id: "home-organization",
        title: "Casa e organização",
        description: "Explique tarefas, organização e pequenos problemas.",
        subject: "vocabulary",
        experienceMode: "vocabulary",
        realWorldGoal:
          "Descrever tarefas domésticas e dar instruções com naturalidade.",
        skills: ["speaking", "vocabulary"],
        searchTerms: ["limpeza", "laundry", "organização", "chores"],
      }),
      experience({
        ...personalDefaults,
        id: "food-cooking",
        title: "Cozinha e alimentação",
        description: "Apresente ingredientes, receitas e escolhas alimentares.",
        subject: "vocabulary",
        experienceMode: "roleplay",
        realWorldGoal:
          "Explicar uma receita ou improvisar uma refeição em inglês.",
        skills: ["speaking", "vocabulary"],
        searchTerms: ["comida", "receita", "cooking", "food", "ingredients"],
      }),
      experience({
        ...personalDefaults,
        id: "skincare-beauty",
        title: "Skincare e beleza",
        description: "Fale de rotinas, produtos, benefícios e preferências.",
        subject: "vocabulary",
        experienceMode: "roleplay",
        realWorldGoal:
          "Apresentar, comparar e recomendar um produto de beleza.",
        skills: ["speaking", "vocabulary"],
        searchTerms: ["beleza", "cosméticos", "skincare", "makeup"],
      }),
      experience({
        ...personalDefaults,
        id: "health-symptoms",
        title: "Saúde e sintomas",
        description: "Aprenda a explicar sintomas e pedir ajuda com clareza.",
        experienceMode: "roleplay",
        realWorldGoal:
          "Comunicar sintomas, duração e intensidade sem buscar diagnóstico.",
        searchTerms: ["saúde", "médico", "farmácia", "symptoms", "doctor"],
      }),
      experience({
        ...personalDefaults,
        id: "shopping",
        title: "Compras",
        description:
          "Pergunte, compare, escolha e resolva problemas de compra.",
        subject: "vocabulary",
        experienceMode: "roleplay",
        realWorldGoal: "Interagir em uma loja e tomar uma decisão de compra.",
        skills: ["speaking", "vocabulary"],
        searchTerms: ["loja", "preço", "shopping", "produto"],
      }),
      experience({
        ...personalDefaults,
        id: "services",
        title: "Serviços",
        description: "Agende, solicite, confirme e resolva imprevistos.",
        experienceMode: "roleplay",
        realWorldGoal:
          "Solicitar um serviço e esclarecer o que precisa ser feito.",
        searchTerms: ["atendimento", "agendamento", "service", "appointment"],
      }),
      experience({
        ...personalDefaults,
        id: "digital-life",
        title: "Vida digital",
        description: "Fale sobre apps, mensagens, conteúdo e segurança online.",
        experienceMode: "guided_lesson",
        realWorldGoal:
          "Explicar como usa uma ferramenta digital ou resolver um problema online.",
        searchTerms: ["tecnologia", "apps", "internet", "digital"],
      }),
    ],
  },
  {
    id: "speaking",
    eyebrow: "Conversação e conexão",
    title: "Pratique falando",
    description:
      "Produções curtas para ganhar espontaneidade, receber correção e tentar novamente.",
    previewLimit: 5,
    items: [
      experience({
        ...personalDefaults,
        id: "record-a-story",
        title: "Grave um story",
        description: "Conte o que está acontecendo em até 30 segundos.",
        experienceMode: "storytelling",
        realWorldGoal:
          "Gravar um story curto e natural sem depender de roteiro.",
        durations: [1, 3, 5],
        modalities: ["voice"],
        searchTerms: ["story", "vídeo", "instagram", "creator"],
      }),
      experience({
        ...personalDefaults,
        id: "tell-a-story",
        title: "Conte uma história",
        description: "Organize contexto, ação, resultado e reflexão.",
        experienceMode: "storytelling",
        realWorldGoal: "Sustentar uma história curta com sequência e detalhes.",
        searchTerms: ["storytelling", "história", "narrativa"],
      }),
      experience({
        ...personalDefaults,
        id: "describe-what-you-see",
        title: "Descreva o que está vendo",
        description: "Observe, organize detalhes e fale com precisão.",
        subject: "vocabulary",
        experienceMode: "vocabulary",
        realWorldGoal:
          "Descrever uma cena, objeto ou ambiente com vocabulário concreto.",
        skills: ["speaking", "vocabulary"],
        durations: [1, 3, 5],
        searchTerms: ["descrição", "imagem", "objetos", "describe"],
      }),
      experience({
        ...personalDefaults,
        id: "give-your-opinion",
        title: "Dê sua opinião",
        description: "Posicione-se, justifique e dê um exemplo.",
        experienceMode: "free_conversation",
        realWorldGoal:
          "Expressar uma opinião e sustentá-la com uma razão e um exemplo.",
        searchTerms: ["opinião", "debate", "opinion", "argument"],
      }),
      experience({
        ...personalDefaults,
        id: "speak-for-a-minute",
        title: "Fale por um minuto",
        description: "Sustente uma ideia com menos pausas e mais conexão.",
        experienceMode: "fluency",
        realWorldGoal: "Falar por sessenta segundos com começo, meio e fim.",
        durations: [1, 3, 5],
        modalities: ["voice"],
        searchTerms: ["fluência", "60 segundos", "one minute"],
      }),
    ],
  },
  {
    id: "kids-teens",
    eyebrow: "Aprender por missões",
    title: "Crianças e adolescentes",
    description:
      "Histórias seguras, escolhas e desafios adequados à idade, com correções curtas.",
    previewLimit: 6,
    items: [
      experience({
        id: "game-worlds",
        title: "Game Worlds",
        description: "Explore um mundo, tome decisões e complete uma missão.",
        subject: "vocabulary",
        experienceMode: "child_mission",
        realWorldGoal:
          "Usar vocabulário simples para decidir e avançar em uma história.",
        audiences: ["kids", "teens"],
        skills: ["speaking", "vocabulary"],
        durations: [5, 10, 15],
        modalities: ["voice", "text", "mixed"],
        searchTerms: ["games", "jogos", "missão", "adventure"],
      }),
      experience({
        id: "roblox-inspired-missions",
        title: "Roblox-Inspired Missions",
        description: "Supere obstáculos em uma missão inspirada em jogos.",
        subject: "grammar",
        experienceMode: "child_mission",
        realWorldGoal:
          "Dar comandos, escolher ações e explicar o próximo passo.",
        audiences: ["kids", "teens"],
        skills: ["speaking"],
        durations: [5, 10, 15],
        modalities: ["voice", "text", "mixed"],
        searchTerms: ["roblox", "obby", "game", "missão"],
      }),
      experience({
        id: "create-your-avatar",
        title: "Create Your Avatar",
        description: "Crie aparência, personalidade e superpoderes.",
        subject: "vocabulary",
        experienceMode: "child_mission",
        realWorldGoal: "Descrever um personagem e explicar suas escolhas.",
        audiences: ["kids", "teens"],
        skills: ["speaking", "vocabulary"],
        durations: [5, 10],
        modalities: ["voice", "text", "mixed"],
        searchTerms: ["avatar", "character", "personagem"],
      }),
      experience({
        id: "school-life",
        title: "School Life",
        description: "Viva situações da escola e converse com personagens.",
        subject: "grammar",
        experienceMode: "teen_challenge",
        realWorldGoal:
          "Interagir em uma situação escolar e resolver um pequeno problema.",
        audiences: ["kids", "teens"],
        skills: ["speaking"],
        durations: [5, 10, 15],
        modalities: ["voice", "text", "mixed"],
        searchTerms: ["escola", "school", "friends", "class"],
      }),
      experience({
        id: "series-characters",
        title: "Series and Characters",
        description: "Descreva personagens e defenda suas escolhas.",
        subject: "reading",
        experienceMode: "teen_challenge",
        realWorldGoal:
          "Falar sobre personagens, relações e acontecimentos de uma história.",
        audiences: ["kids", "teens"],
        skills: ["speaking", "reading"],
        durations: [5, 10],
        modalities: ["voice", "text", "mixed"],
        searchTerms: ["séries", "characters", "cartoons", "personagens"],
      }),
      experience({
        id: "mystery-adventures",
        title: "Mystery Adventures",
        description: "Encontre pistas, faça perguntas e resolva o mistério.",
        subject: "listening",
        experienceMode: "child_mission",
        realWorldGoal:
          "Compreender pistas e fazer perguntas para resolver uma história.",
        audiences: ["kids", "teens"],
        skills: ["speaking", "listening"],
        durations: [10, 15],
        modalities: ["voice", "mixed"],
        searchTerms: ["mistério", "adventure", "clues", "pistas"],
      }),
    ],
  },
  {
    id: "career",
    eyebrow: "Prepare sua próxima posição",
    title: "Carreira",
    description:
      "Pratique processos seletivos, apresentações profissionais e conversas que mudam uma trajetória.",
    previewLimit: 6,
    items: [
      experience({
        ...professionalDefaults,
        id: "job-interviews",
        title: "Entrevistas",
        description: "Responda perguntas adaptadas à sua profissão.",
        subject: "writing",
        experienceMode: "interview",
        realWorldGoal:
          "Responder com exemplos concretos e aprofundar quando questionado.",
        skills: ["speaking", "writing"],
        searchTerms: ["entrevista", "job interview", "recruiter", "STAR"],
      }),
      experience({
        ...professionalDefaults,
        id: "first-job",
        title: "Primeiro emprego",
        description: "Apresente potencial mesmo com pouca experiência.",
        subject: "writing",
        experienceMode: "interview",
        realWorldGoal:
          "Apresentar habilidades, estudos e motivação para a primeira oportunidade.",
        skills: ["speaking", "writing"],
        searchTerms: ["primeiro emprego", "estágio", "first job"],
        audiences: ["teens", "adult", "professional"],
      }),
      experience({
        ...professionalDefaults,
        id: "multinationals",
        title: "Multinacionais",
        description: "Prepare-se para colaborar em um ambiente global.",
        subject: "global_meetings",
        sector: "projects_operations",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Apresentar contexto, alinhar decisões e confirmar próximos passos.",
        skills: ["speaking", "presentation"],
        searchTerms: ["multinacional", "international company", "global"],
      }),
      experience({
        ...professionalDefaults,
        id: "promotion",
        title: "Promoção",
        description: "Apresente resultados, impacto e prontidão.",
        subject: "writing",
        experienceMode: "interview",
        realWorldGoal:
          "Defender uma promoção com evidências e visão de próximo nível.",
        skills: ["speaking", "writing", "presentation"],
        searchTerms: ["promoção", "leadership", "career growth"],
      }),
      experience({
        ...professionalDefaults,
        id: "career-networking",
        title: "Networking",
        description: "Inicie conversas e apresente seu trabalho.",
        subject: "grammar",
        experienceMode: "roleplay",
        realWorldGoal:
          "Entrar em uma conversa, apresentar-se e criar uma conexão profissional.",
        skills: ["speaking"],
        searchTerms: ["networking", "linkedin", "professional introduction"],
      }),
      experience({
        ...professionalDefaults,
        id: "career-change",
        title: "Mudança de carreira",
        description: "Conecte sua experiência anterior ao novo objetivo.",
        subject: "writing",
        experienceMode: "interview",
        realWorldGoal:
          "Explicar uma transição de carreira de forma coerente e convincente.",
        skills: ["speaking", "writing"],
        searchTerms: ["mudança de carreira", "career change", "transition"],
      }),
    ],
  },
  {
    id: "global-meetings",
    eyebrow: "Trabalho sem fronteiras",
    title: "Reuniões globais",
    description:
      "Cenários específicos por setor para construir, apresentar, responder e readaptar sua mensagem.",
    previewLimit: 6,
    items: [
      experience({
        ...professionalDefaults,
        id: "meetings-business",
        title: "Negócios",
        description: "Decisões, resultados e próximos passos.",
        subject: "global_meetings",
        sector: "projects_operations",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Conduzir uma reunião de negócios com objetivo e fechamento claros.",
        skills: ["speaking", "presentation"],
        searchTerms: ["business", "negócios", "reunião"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-medicine",
        title: "Medicina",
        description: "Casos, pesquisas e colaboração internacional.",
        subject: "global_meetings",
        sector: "pharma_health",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Apresentar informação médica e participar de uma discussão profissional.",
        skills: ["speaking", "presentation"],
        searchTerms: ["medicina", "healthcare", "medical", "congressos"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-human-reproduction",
        title: "Reprodução humana",
        description: "Clínicas, laboratórios e equipes multidisciplinares.",
        subject: "global_meetings",
        sector: "pharma_health",
        experienceMode: "presentation",
        realWorldGoal:
          "Apresentar processos e resultados de reprodução humana com precisão.",
        skills: ["speaking", "presentation"],
        searchTerms: ["reprodução humana", "fertility", "embryology", "ivf"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-laboratories",
        title: "Laboratórios",
        description: "Processos, qualidade, resultados e segurança.",
        subject: "global_meetings",
        sector: "pharma_health",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Explicar um processo laboratorial e discutir resultados com a equipe.",
        skills: ["speaking", "presentation"],
        searchTerms: ["laboratório", "laboratory", "quality", "research"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-beauty",
        title: "Beleza",
        description: "Produtos, lançamentos e distribuição.",
        subject: "global_meetings",
        sector: "beauty_cosmetics_perfumery",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Apresentar um produto e alinhar lançamento ou distribuição.",
        skills: ["speaking", "presentation"],
        searchTerms: ["beleza", "cosmetics", "beauty", "launch"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-retail",
        title: "Varejo",
        description: "Compras, margem, estoque e canais.",
        subject: "global_meetings",
        sector: "retail_wholesale",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Discutir indicadores de varejo e propor uma decisão comercial.",
        skills: ["speaking", "presentation"],
        searchTerms: ["varejo", "retail", "atacado", "estoque"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-technology",
        title: "Tecnologia",
        description: "Produto, dados, incidentes e alinhamento técnico.",
        subject: "global_meetings",
        sector: "technology_ai",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Explicar um problema técnico e alinhar uma decisão entre áreas.",
        skills: ["speaking", "presentation"],
        searchTerms: ["tecnologia", "technology", "software", "AI"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-logistics",
        title: "Logística",
        description: "Prazos, rotas, fornecedores e continuidade.",
        subject: "global_meetings",
        sector: "logistics",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Apresentar um risco logístico e negociar um plano de ação.",
        skills: ["speaking", "presentation"],
        searchTerms: ["logística", "logistics", "supplier", "delivery"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-tourism",
        title: "Turismo",
        description: "Experiência do cliente, parceiros e operações.",
        subject: "global_meetings",
        sector: "tourism_hospitality",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Alinhar uma operação turística com parceiros internacionais.",
        skills: ["speaking", "presentation"],
        searchTerms: ["turismo", "hospitality", "travel", "guests"],
      }),
      experience({
        ...professionalDefaults,
        id: "meetings-aviation",
        title: "Aviação",
        description: "Equipes, passageiros, atrasos e segurança.",
        subject: "global_meetings",
        sector: "tourism_hospitality",
        experienceMode: "global_meeting",
        realWorldGoal:
          "Comunicar um cenário de aviação com clareza e responsabilidade.",
        skills: ["speaking", "presentation"],
        searchTerms: ["aviação", "aviation", "cabin crew", "pilot"],
      }),
    ],
  },
  {
    id: "events",
    eyebrow: "Comunicação que circula",
    title: "Eventos e convenções",
    description:
      "Chegue, apresente-se, participe e dê continuidade a conversas em eventos internacionais.",
    previewLimit: 6,
    items: [
      experience({
        ...professionalDefaults,
        id: "events-networking",
        title: "Networking",
        description: "Comece, aprofunde e encerre uma conversa.",
        subject: "grammar",
        experienceMode: "roleplay",
        realWorldGoal:
          "Entrar em uma conversa de evento e criar um próximo contato.",
        skills: ["speaking"],
        searchTerms: ["networking", "evento", "contacts"],
      }),
      experience({
        ...professionalDefaults,
        id: "medical-congresses",
        title: "Congressos médicos",
        description: "Apresente sua área e converse sobre pesquisa.",
        subject: "global_meetings",
        sector: "pharma_health",
        experienceMode: "presentation",
        realWorldGoal:
          "Apresentar-se e discutir trabalho científico em um congresso.",
        skills: ["speaking", "presentation"],
        searchTerms: ["congresso médico", "medical congress", "research"],
      }),
      experience({
        ...professionalDefaults,
        id: "talks",
        title: "Palestras",
        description: "Estruture a mensagem e responda perguntas.",
        subject: "global_meetings",
        sector: "projects_operations",
        experienceMode: "presentation",
        realWorldGoal:
          "Apresentar uma ideia com estrutura e lidar com perguntas da audiência.",
        skills: ["speaking", "presentation"],
        searchTerms: ["palestra", "talk", "speaker", "Q&A"],
      }),
      experience({
        ...professionalDefaults,
        id: "panels",
        title: "Painéis",
        description: "Entre no debate, compare e complemente ideias.",
        subject: "grammar",
        experienceMode: "presentation",
        realWorldGoal:
          "Participar de um painel com respostas concisas e conectadas.",
        skills: ["speaking", "presentation"],
        searchTerms: ["painel", "panel discussion", "debate"],
      }),
      experience({
        ...professionalDefaults,
        id: "trade-shows",
        title: "Feiras",
        description: "Visite estandes e apresente produtos.",
        subject: "vocabulary",
        experienceMode: "roleplay",
        realWorldGoal:
          "Apresentar um produto, fazer perguntas e identificar oportunidades.",
        skills: ["speaking", "vocabulary"],
        searchTerms: ["feira", "trade show", "booth", "exhibition"],
      }),
      experience({
        ...professionalDefaults,
        id: "poster-presentation",
        title: "Apresentação de pôster",
        description: "Explique objetivo, método, resultado e relevância.",
        subject: "global_meetings",
        sector: "pharma_health",
        experienceMode: "presentation",
        realWorldGoal:
          "Apresentar um pôster e responder perguntas técnicas com clareza.",
        skills: ["speaking", "presentation"],
        searchTerms: ["poster", "scientific presentation", "pesquisa"],
      }),
    ],
  },
  {
    id: "international-exams",
    eyebrow: "Treino com critérios",
    title: "Provas internacionais",
    description:
      "Pratique formatos, tempo e habilidades de provas sem confundir simulação educacional com avaliação oficial.",
    previewLimit: 5,
    items: [
      experience({
        ...examDefaults,
        id: "exam-cambridge",
        title: "Cambridge",
        description: "Speaking, Reading, Writing, Listening e Use of English.",
        subject: "grammar",
        experienceMode: "exam",
        realWorldGoal:
          "Praticar uma tarefa compatível com o nível e receber feedback após a etapa.",
        skills: ["speaking", "reading", "writing", "listening"],
        searchTerms: [
          "cambridge",
          "A2 Key",
          "B1 Preliminary",
          "B2 First",
          "C1",
        ],
      }),
      experience({
        ...examDefaults,
        id: "exam-toefl",
        title: "TOEFL",
        description: "Integre leitura, listening, fala e escrita acadêmica.",
        subject: "listening",
        experienceMode: "exam",
        realWorldGoal:
          "Responder uma tarefa acadêmica com estrutura e controle de tempo.",
        skills: ["speaking", "listening", "writing", "reading"],
        searchTerms: ["TOEFL", "academic", "integrated task"],
      }),
      experience({
        ...examDefaults,
        id: "exam-ielts",
        title: "IELTS",
        description: "Treine tarefas acadêmicas, gerais e speaking.",
        subject: "writing",
        experienceMode: "exam",
        realWorldGoal:
          "Completar uma tarefa de prática com resposta organizada e feedback.",
        skills: ["speaking", "listening", "writing", "reading"],
        searchTerms: ["IELTS", "academic", "general training"],
      }),
      experience({
        ...examDefaults,
        id: "exam-toeic",
        title: "TOEIC",
        description: "Compreenda comunicação profissional sob tempo.",
        subject: "listening",
        experienceMode: "exam",
        realWorldGoal:
          "Identificar informação relevante em situações profissionais.",
        skills: ["listening", "reading"],
        searchTerms: ["TOEIC", "business", "workplace"],
      }),
      experience({
        ...examDefaults,
        id: "exam-duolingo",
        title: "Duolingo English Test",
        description: "Pratique respostas rápidas em diferentes habilidades.",
        subject: "grammar",
        experienceMode: "exam",
        realWorldGoal:
          "Responder tarefas curtas com clareza, precisão e uso consciente do tempo.",
        skills: ["speaking", "listening", "writing", "reading"],
        searchTerms: ["DET", "Duolingo English Test", "adaptive test"],
      }),
    ],
  },
  {
    id: "skill-labs",
    eyebrow: "Prática focada",
    title: "Laboratórios de habilidade",
    description:
      "Isole um ponto, pratique em contexto e leve o resultado para uma situação real.",
    previewLimit: 5,
    items: [
      experience({
        ...personalDefaults,
        id: "listening-lab",
        title: "Listening Lab",
        description: "Ouça, identifique, responda e reutilize o conteúdo.",
        subject: "listening",
        experienceMode: "guided_lesson",
        realWorldGoal:
          "Compreender a ideia principal e responder de forma adequada.",
        skills: ["listening", "speaking"],
        modalities: ["voice", "mixed"],
        searchTerms: ["listening", "áudio", "compreensão"],
      }),
      experience({
        ...personalDefaults,
        id: "pronunciation-lab",
        title: "Pronunciation Lab",
        description: "Trabalhe clareza, ritmo e uma nova tentativa.",
        subject: "listening",
        experienceMode: "pronunciation",
        realWorldGoal:
          "Produzir uma frase com mais clareza e ritmo em um contexto real.",
        skills: ["pronunciation", "speaking", "listening"],
        modalities: ["voice"],
        searchTerms: ["pronúncia", "pronunciation", "shadowing", "ritmo"],
      }),
      experience({
        ...personalDefaults,
        id: "writing-lab",
        title: "Writing Lab",
        description: "Escreva, corrija e reformule uma mensagem real.",
        subject: "writing",
        experienceMode: "writing",
        realWorldGoal:
          "Produzir um texto útil e aplicar a correção em uma nova versão.",
        skills: ["writing"],
        modalities: ["text"],
        searchTerms: ["writing", "escrita", "mensagem", "texto"],
      }),
      experience({
        ...personalDefaults,
        id: "vocabulary-lab",
        title: "Vocabulary Lab",
        description: "Aprenda chunks e use-os em uma situação.",
        subject: "vocabulary",
        experienceMode: "vocabulary",
        realWorldGoal:
          "Usar novas expressões em frases próprias e recuperar repertório anterior.",
        skills: ["vocabulary", "speaking"],
        searchTerms: ["vocabulário", "vocabulary", "chunks"],
      }),
      experience({
        ...professionalDefaults,
        id: "presentation-lab",
        title: "Presentation Lab",
        description: "Estruture, ensaie e responda perguntas.",
        subject: "global_meetings",
        sector: "projects_operations",
        experienceMode: "presentation",
        realWorldGoal:
          "Apresentar uma mensagem com lógica e responder uma pergunta inesperada.",
        skills: ["presentation", "speaking"],
        searchTerms: ["apresentação", "presentation", "pitch", "Q&A"],
      }),
    ],
  },
];

export const FEATURED_EXPERIENCES: FeaturedExperience[] = [
  {
    experienceId: "my-routine",
    title: "Inglês para a sua rotina",
    description:
      "Fale sobre sua casa, seus hábitos, seus produtos, sua alimentação e tudo o que faz parte do seu dia.",
    callToAction: "Transformar sua própria vida em prática de inglês.",
    metaLabel: "Inglês para a vida real",
  },
  {
    experienceId: "record-a-story",
    title: "Seu story em inglês",
    description:
      "Grave vídeos curtos sobre seu dia, receba correções e tente novamente com mais naturalidade.",
    callToAction: "Começar a falar sem depender de um roteiro.",
    metaLabel: "Pratique falando",
  },
  {
    experienceId: "meetings-medicine",
    title: "Medicina, congressos e reuniões globais",
    description:
      "Pratique apresentações científicas, discussões profissionais, networking e comunicação em eventos internacionais.",
    callToAction: "Comunicar seu conhecimento para o mundo.",
    metaLabel: "Medicina e convenções",
  },
  {
    experienceId: "meetings-human-reproduction",
    title: "Human Reproduction English",
    description:
      "Treine situações de clínicas, laboratórios, pesquisas, congressos e reuniões multidisciplinares.",
    callToAction: "Apresentar processos e resultados com precisão.",
    metaLabel: "Inglês por profissão",
  },
  {
    experienceId: "exam-cambridge",
    title: "Simulações de provas internacionais",
    description:
      "Treine Cambridge, TOEFL, IELTS e TOEIC com tempo, feedback imediato e novas tentativas.",
    callToAction: "Chegar à prova já familiarizado com cada etapa.",
    metaLabel: "Provas internacionais",
  },
  {
    experienceId: "job-interviews",
    title: "Viva sua futura carreira em inglês",
    description:
      "Escolha uma profissão e pratique entrevistas, rotinas, problemas e situações reais da área.",
    callToAction: "Treinar hoje para ocupar sua próxima posição.",
    metaLabel: "Minha futura profissão",
  },
  {
    experienceId: "listening-lab",
    title: "Listening para todos os níveis",
    description:
      "Ouça situações reais, identifique informações, responda e utilize o conteúdo na prática.",
    callToAction: "Compreender, responder e participar.",
    metaLabel: "Listening Lab",
  },
];

export const ALL_EXPERIENCES = LEARNING_UNIVERSES.flatMap(
  (universe) => universe.items,
);

export const getExperienceById = (
  experienceId: string,
): LearningExperience | undefined =>
  ALL_EXPERIENCES.find((item) => item.id === experienceId);

export const getUniverseForExperience = (
  experienceId: string,
): LearningUniverse | undefined =>
  LEARNING_UNIVERSES.find((universe) =>
    universe.items.some((item) => item.id === experienceId)
  );

export interface ExperienceAudienceProfile {
  isKids?: boolean;
  is_kids?: boolean;
  studentCategory?: string;
  student_category?: string;
  occupation?: string;
}

export const inferExperienceAudience = (
  profile: ExperienceAudienceProfile,
): ExperienceAudience => {
  if (profile.isKids === true || profile.is_kids === true) return "kids";
  const category = normalizeRecommendationText(
    profile.studentCategory ?? profile.student_category ?? "",
  );
  if (/crianca|kids|infantil/.test(category)) return "kids";
  if (/adolesc|teen|ensino medio/.test(category)) return "teens";
  if (/execut|profission/.test(category) || profile.occupation?.trim()) {
    return "professional";
  }
  return "adult";
};

export const experienceSupportsAudience = (
  experience: LearningExperience,
  audience: ExperienceAudience,
): boolean =>
  audience === "all" ||
  (audience !== "kids" && experience.audiences.includes("all")) ||
  experience.audiences.includes(audience);

export const pickAudienceCompatibleExperience = (
  audience: ExperienceAudience,
  candidates: ReadonlyArray<LearningExperience | null | undefined>,
): LearningExperience | undefined =>
  candidates.find(
    (candidate): candidate is LearningExperience =>
      Boolean(candidate && experienceSupportsAudience(candidate, audience)),
  );

const normalizeRecommendationText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const recommendationAliases: Array<
  { pattern: RegExp; experienceIds: string[]; boost?: number }
> = [
  {
    pattern: /medic|saude|health|clinic|hospital/,
    experienceIds: [
      "meetings-medicine",
      "medical-congresses",
      "health-symptoms",
    ],
  },
  {
    pattern: /reproduc|fertil|embri|ivf/,
    experienceIds: ["meetings-human-reproduction", "medical-congresses"],
    boost: 28,
  },
  {
    pattern: /laborat|pesquisa|research/,
    experienceIds: ["meetings-laboratories", "poster-presentation"],
  },
  {
    pattern:
      /tecnolog|software|ti|data|dados|program|ai|inteligencia artificial/,
    experienceIds: [
      "meetings-technology",
      "multinationals",
      "presentation-lab",
    ],
  },
  {
    pattern: /aviacao|aviation|piloto|comiss|flight/,
    experienceIds: ["meetings-aviation", "events-networking"],
  },
  {
    pattern: /turismo|hotel|hospitality|viagem|travel/,
    experienceIds: ["meetings-tourism", "services", "events-networking"],
  },
  {
    pattern: /varejo|retail|vendas|sales|comercial/,
    experienceIds: [
      "meetings-retail",
      "career-networking",
      "give-your-opinion",
    ],
  },
  {
    pattern: /logistic|supply|operac|projeto/,
    experienceIds: [
      "meetings-logistics",
      "meetings-business",
      "presentation-lab",
    ],
  },
  {
    pattern: /beleza|beauty|estetica|skincare/,
    experienceIds: ["meetings-beauty", "skincare-beauty"],
  },
  {
    pattern: /crianca|kids|adolesc|teen|game|jogo|roblox/,
    experienceIds: ["game-worlds", "roblox-inspired-missions", "school-life"],
  },
  {
    pattern: /toefl/,
    experienceIds: ["exam-toefl", "listening-lab", "writing-lab"],
  },
  {
    pattern: /ielts/,
    experienceIds: ["exam-ielts", "listening-lab", "writing-lab"],
  },
  {
    pattern: /cambridge/,
    experienceIds: ["exam-cambridge", "speak-for-a-minute"],
  },
  { pattern: /toeic/, experienceIds: ["exam-toeic", "meetings-business"] },
  {
    pattern: /duolingo/,
    experienceIds: ["exam-duolingo", "speak-for-a-minute"],
  },
  {
    pattern: /entrevista|emprego|job|vaga|carreira|career/,
    experienceIds: ["job-interviews", "first-job", "career-networking"],
  },
  {
    pattern: /reuniao|meeting|lider|leadership|gestao|management/,
    experienceIds: [
      "meetings-business",
      "presentation-lab",
      "career-networking",
    ],
  },
  {
    pattern: /apresent|presentation|palestra|pitch|congresso|evento/,
    experienceIds: ["presentation-lab", "talks", "medical-congresses"],
  },
  {
    pattern: /cozinha|comida|cook|food|gastronom/,
    experienceIds: ["food-cooking", "my-routine"],
  },
  {
    pattern: /pronuncia|pronunciation|accent|sotaque/,
    experienceIds: ["pronunciation-lab", "record-a-story"],
  },
  {
    pattern: /escrev|writing|email|relatorio|report/,
    experienceIds: ["writing-lab", "presentation-lab"],
  },
];

export const recommendExperiences = (
  profile: ExperienceRecommendationProfile,
  limit = 6,
): LearningExperience[] => {
  const interests = Array.isArray(profile.interests)
    ? profile.interests.join(" ")
    : profile.interests || "";
  const context = normalizeRecommendationText(
    `${profile.role || ""} ${profile.goal || ""} ${interests}`,
  );
  const tokens = [
    ...new Set(context.split(" ").filter((token) => token.length >= 4)),
  ];
  const aliasScores = new Map<string, number>();
  recommendationAliases.forEach(({ pattern, experienceIds, boost = 16 }) => {
    if (pattern.test(context)) {
      experienceIds.forEach((id, index) =>
        aliasScores.set(
          id,
          Math.max(aliasScores.get(id) || 0, boost - index * 3),
        )
      );
    }
  });

  const eligibleExperiences = profile.audience && profile.audience !== "all"
    ? ALL_EXPERIENCES.filter((item) =>
      experienceSupportsAudience(item, profile.audience!)
    )
    : ALL_EXPERIENCES;

  return eligibleExperiences
    .map((item, index) => {
      const searchable = normalizeRecommendationText(
        `${item.title} ${item.description} ${item.realWorldGoal} ${
          item.searchTerms.join(" ")
        }`,
      );
      const tokenScore = tokens.reduce(
        (score, token) => score + (searchable.includes(token) ? 2 : 0),
        0,
      );
      const audienceScore =
        !profile.audience || item.audiences.includes("all") ||
          item.audiences.includes(profile.audience)
          ? 3
          : -5;
      const modalityScore = profile.preferredModality &&
          item.modalities.includes(profile.preferredModality)
        ? 2
        : 0;
      const baseline = item.id === "introduce-yourself"
        ? 1
        : item.id === "record-a-story"
        ? 0.5
        : 0;
      return {
        item,
        index,
        score: (aliasScores.get(item.id) || 0) + tokenScore + audienceScore +
          modalityScore + baseline,
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, limit))
    .map(({ item }) => item);
};
