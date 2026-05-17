import { supabase } from '../lib/supabase';

export interface GeneratedActivity {
    type: 'reading' | 'grammar' | 'quiz' | 'conversation';
    title: string;
    description: string;
    content: string;
    difficulty: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
    xp_reward: number;
}

export const generateActivities = async (profile: {
    english_for?: string;
    student_category?: string;
    personality?: string;
    preferred_topics?: string[];
    avoided_topics?: string[];
    short_term_goal?: string;
    module?: string;
}, wolfIntelligence?: {
    accumulated_context?: string;
    weak_points?: string[];
    recommended_approach?: string;
}): Promise<GeneratedActivity[]> => {
    try {
        const profileSummary = [
            profile.english_for && `Objetivo: ${profile.english_for}`,
            profile.student_category && `Perfil: ${profile.student_category}`,
            profile.personality && `Estilo: ${profile.personality}`,
            profile.preferred_topics?.length && `Tópicos preferidos: ${profile.preferred_topics.join(', ')}`,
            profile.avoided_topics?.length && `Evitar: ${profile.avoided_topics.join(', ')}`,
            profile.short_term_goal && `Meta curto prazo: ${profile.short_term_goal}`,
            profile.module && `Nível atual: ${profile.module}`,
        ].filter(Boolean).join('\n');

        const wolfSummary = wolfIntelligence ? [
            wolfIntelligence.accumulated_context && `Contexto acumulado: ${wolfIntelligence.accumulated_context}`,
            wolfIntelligence.weak_points?.length && `Pontos a melhorar: ${wolfIntelligence.weak_points.join(', ')}`,
            wolfIntelligence.recommended_approach && `Abordagem recomendada: ${wolfIntelligence.recommended_approach}`,
        ].filter(Boolean).join('\n') : '';

        const prompt = `Você é um especialista em pedagogia de inglês. Com base no perfil do aluno abaixo, gere EXATAMENTE 4 atividades complementares personalizadas em formato JSON.

PERFIL DO ALUNO:
${profileSummary}

${wolfSummary ? `INTELIGÊNCIA WOLF (histórico das aulas):\n${wolfSummary}` : ''}

Retorne APENAS um array JSON válido com 4 objetos, cada um com os campos:
- type: "reading" | "grammar" | "quiz" | "conversation"
- title: título curto da atividade (máx 60 chars)
- description: o que o aluno vai praticar (máx 120 chars)
- content: instruções detalhadas da atividade para o aluno executar (3-5 frases claras)
- difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED"
- xp_reward: número entre 30 e 150 (proporcional à dificuldade)

As atividades devem ser 100% alinhadas com o perfil, variadas nos tipos e práticas para fazer sozinho.
Responda APENAS com o JSON, sem markdown, sem explicação.`;

        const { data, error } = await supabase.functions.invoke('wolfie-brain', {
            body: {
                message: prompt,
                studentLevel: profile.module || 'B1',
                previousContext: 'System: You are a JSON-only pedagogical activity generator. Return only valid JSON arrays.'
            }
        });

        if (error) throw error;

        const rawText = data?.aiText || '';
        // Extract JSON array from response
        const match = rawText.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('No JSON array in response');

        const activities: GeneratedActivity[] = JSON.parse(match[0]);
        return activities.slice(0, 4);
    } catch (err) {
        console.error('generateActivities error:', err);
        // Fallback activities based on english_for
        return getFallbackActivities(profile.english_for || 'Inglês Geral / Conversação', profile.module || 'B1');
    }
};

const getFallbackActivities = (englishFor: string, level: string): GeneratedActivity[] => {
    const isBusiness = englishFor.includes('Business') || englishFor.includes('Empresar');
    const isToefl = englishFor.includes('TOEFL') || englishFor.includes('IELTS');

    return [
        {
            type: 'reading',
            title: isBusiness ? 'Leitura: E-mail Profissional' : isToefl ? 'Leitura: Texto Acadêmico' : 'Leitura: Artigo do Dia',
            description: 'Pratique leitura e compreensão em contexto real',
            content: isBusiness
                ? 'Leia um e-mail profissional em inglês e identifique: 1) O objetivo do e-mail, 2) O tom usado (formal/informal), 3) Três expressões que você pode reutilizar. Escreva uma resposta curta usando essas expressões.'
                : 'Leia um artigo curto em inglês sobre um tema de seu interesse. Identifique 5 palavras novas, pesquise seus significados e escreva uma frase com cada uma.',
            difficulty: level >= 'B2' ? 'ADVANCED' : 'INTERMEDIATE',
            xp_reward: 60
        },
        {
            type: 'grammar',
            title: 'Gramática em Contexto',
            description: 'Pratique estruturas gramaticais do seu nível',
            content: 'Escreva 10 frases usando tempos verbais variados (presente simples, passado simples e futuro). O tema das frases deve ser relacionado ao seu dia a dia profissional ou pessoal. Revise cada frase verificando: sujeito, verbo e complemento.',
            difficulty: 'INTERMEDIATE',
            xp_reward: 50
        },
        {
            type: 'conversation',
            title: isBusiness ? 'Simulação: Reunião em Inglês' : 'Prática: Conversa do Cotidiano',
            description: 'Pratique speaking com situações reais',
            content: isBusiness
                ? 'Grave um áudio de 2 minutos simulando a abertura de uma reunião em inglês: apresente-se, apresente a pauta e faça uma pergunta ao "cliente". Ouça e identifique pontos de melhoria.'
                : 'Escolha um tema que você gosta (viagem, tecnologia, esporte) e grave um áudio de 1-2 minutos falando sobre ele em inglês. Foque em falar sem parar e sem traduzir mentalmente.',
            difficulty: level >= 'B2' ? 'ADVANCED' : 'INTERMEDIATE',
            xp_reward: 80
        },
        {
            type: 'quiz',
            title: 'Quiz: Vocabulário Temático',
            description: 'Teste e expanda seu vocabulário',
            content: isToefl
                ? 'Pesquise 10 palavras acadêmicas (Academic Word List) que você ainda não domina. Para cada uma: escreva a definição em inglês, um sinônimo e uma frase de exemplo. Depois se teste: cubra as definições e tente lembrar.'
                : 'Escolha uma área de vocabulário (cores, profissões, alimentos, viagens) e liste 15 palavras. Para cada palavra, escreva a tradução e uma frase curta. Repita em voz alta 3 vezes.',
            difficulty: 'BEGINNER',
            xp_reward: 40
        }
    ];
};

export const getPedagogicalSuggestion = async (module: string, lastContent: string) => {
  try {
    const prompt = `O aluno está no módulo ${module}. O último conteúdo aplicado foi: "${lastContent}". Sugira um tópico de 1 frase para a próxima aula e uma breve dica pedagógica.`;

    // Call Wolfie Brain (Edge Function) instead of direct Gemini API
    const { data, error } = await supabase.functions.invoke('wolfie-brain', {
      body: {
        message: prompt,
        studentLevel: module,
        previousContext: "System: You are acting as a Pedagogical Advisor now."
      }
    });

    if (error) throw error;
    if (data?.aiText) return data.aiText;

    return "Dica não disponível no momento.";
  } catch (error: any) {
    console.error("Gemini Suggestion Error Details:", error);
    if (error.context && typeof error.context.json === 'function') {
      error.context.json().then((errBody: any) => console.error("Edge Function Body:", errBody));
    }
    return "Sugestão indisponível no momento.";
  }
};

export const generateBillingReminder = async (studentName: string, amount: number, dueDate: string, tone: 'friendly' | 'professional' | 'urgent') => {
  try {
    const ai = getRequestConfig();
    if (!ai) return "Configuração de IA ausente.";

    const prompt = `Escreva um e-mail curto e elegante de lembrete de pagamento para o aluno ${studentName}. 
    Valor: R$ ${amount}. Vencimento: ${dueDate}. 
    Tom de voz: ${tone === 'friendly' ? 'Amigável e leve' : tone === 'urgent' ? 'Urgente e sério' : 'Profissional e direto'}. 
    O e-mail deve ser em português, incluir um espaço para o link do boleto/pix e terminar com o nome da escola (use [Nome da Escola]).`;

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: prompt,
      config: {
        temperature: 0.8,
      },
    });
    return response.text();
  } catch (error) {
    console.error("Gemini Billing Error:", error);
    return `Olá ${studentName}, lembramos que sua fatura de R$ ${amount} vence em ${dueDate}. Por favor, regularize seu débito.`;
  }
};
