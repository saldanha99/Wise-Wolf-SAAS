import {
    FunctionsFetchError,
    FunctionsHttpError,
    FunctionsRelayError,
} from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

export interface GeneratedActivity {
    id: string;
    type: 'reading' | 'grammar' | 'quiz' | 'conversation';
    title: string;
    description: string | null;
    content: Record<string, unknown>;
    difficulty: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED';
    status: 'PENDING' | 'COMPLETED';
    student_id?: string;
    tenant_id?: string;
    completed_at?: string | null;
    created_at?: string;
    generated_by_ai?: boolean;
}

export interface GeneratedActivitiesResult {
    activities: GeneratedActivity[];
    source: 'server' | 'replay';
    requestKey: string;
}

export class ActivityGenerationError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly status?: number;

    constructor(
        message: string,
        details: { code: string; retryable: boolean; status?: number },
    ) {
        super(message);
        this.name = 'ActivityGenerationError';
        this.code = details.code;
        this.retryable = details.retryable;
        this.status = details.status;
    }
}

type UnknownRecord = Record<string, unknown>;

const ACTIVITY_TYPES = new Set<GeneratedActivity['type']>([
    'reading',
    'grammar',
    'quiz',
    'conversation',
]);
const ACTIVITY_DIFFICULTIES = new Set<GeneratedActivity['difficulty']>([
    'BEGINNER',
    'INTERMEDIATE',
    'ADVANCED',
]);
const RETRYABLE_FUNCTION_STATUSES = new Set([408, 425]);
const STUDENT_COMPLEMENTARY_ACTION = 'student_complementary_pack';
const FORBIDDEN_STUDENT_CONTENT_KEYS = new Set([
    'correct',
    'correctindex',
    'correct_option_index',
    'exp',
    'explanation',
    'explanation_pt',
    'feedback',
]);

const asRecord = (value: unknown): UnknownRecord | null => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as UnknownRecord
        : null
);

const containsForbiddenStudentContent = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsForbiddenStudentContent);
    const record = asRecord(value);
    if (!record) return false;
    return Object.entries(record).some(([key, child]) => (
        FORBIDDEN_STUDENT_CONTENT_KEYS.has(key.toLowerCase())
        || containsForbiddenStudentContent(child)
    ));
};

const extractSavedActivityArray = (payload: unknown): GeneratedActivity[] | null => {
    const response = asRecord(payload);
    const candidate = Array.isArray(response?.activities) ? response.activities : null;
    if (!candidate || candidate.length < 1 || candidate.length > 4) return null;

    const parsed: GeneratedActivity[] = [];
    const seenIds = new Set<string>();
    const seenTypes = new Set<GeneratedActivity['type']>();
    for (const item of candidate) {
        const activity = asRecord(item);
        const id = typeof activity?.id === 'string' ? activity.id.trim() : '';
        const type = typeof activity?.type === 'string'
            ? activity.type as GeneratedActivity['type']
            : null;
        const difficulty = typeof activity?.difficulty === 'string'
            ? activity.difficulty as GeneratedActivity['difficulty']
            : null;
        const title = typeof activity?.title === 'string' ? activity.title.trim() : '';
        const description = activity?.description === null
            ? null
            : typeof activity?.description === 'string'
                ? activity.description.trim()
                : null;
        const content = asRecord(activity?.content);
        const status = activity?.status === 'PENDING' || activity?.status === 'COMPLETED'
            ? activity.status
            : null;

        if (
            !id
            || seenIds.has(id)
            || !type
            || !ACTIVITY_TYPES.has(type)
            || seenTypes.has(type)
            || !difficulty
            || !ACTIVITY_DIFFICULTIES.has(difficulty)
            || !title
            || !content
            || !status
            || containsForbiddenStudentContent(content)
        ) {
            return null;
        }

        if (typeof content === 'object') {
            const serialized = JSON.stringify(content);
            if (serialized.length < 20 || serialized.length > 18_000) return null;
        }

        parsed.push({
            id,
            type,
            title,
            description,
            content,
            difficulty,
            status,
            student_id: typeof activity.student_id === 'string' ? activity.student_id : undefined,
            tenant_id: typeof activity.tenant_id === 'string' ? activity.tenant_id : undefined,
            completed_at: typeof activity.completed_at === 'string'
                ? activity.completed_at
                : activity.completed_at === null
                    ? null
                    : undefined,
            created_at: typeof activity.created_at === 'string' ? activity.created_at : undefined,
            generated_by_ai: typeof activity.generated_by_ai === 'boolean'
                ? activity.generated_by_ai
                : undefined,
        });
        seenIds.add(id);
        seenTypes.add(type);
    }
    return parsed;
};

const functionErrorStatus = (error: FunctionsHttpError): number | undefined => {
    const context = asRecord(error.context);
    return typeof context?.status === 'number' ? context.status : undefined;
};

const functionErrorCode = async (error: FunctionsHttpError): Promise<string | null> => {
    const context = error.context;
    if (!(context instanceof Response)) return null;
    try {
        const payload = asRecord(await context.clone().json());
        const code = payload?.code ?? payload?.error;
        return typeof code === 'string' && code.trim() ? code.trim() : null;
    } catch {
        return null;
    }
};

const normalizeActivityGenerationError = async (error: unknown): Promise<ActivityGenerationError> => {
    if (error instanceof ActivityGenerationError) return error;
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
        return new ActivityGenerationError(
            'Não foi possível conectar ao gerador de atividades. Tente novamente.',
            { code: 'ACTIVITY_GENERATOR_UNREACHABLE', retryable: true },
        );
    }
    if (error instanceof FunctionsHttpError) {
        const status = functionErrorStatus(error);
        const providerCode = await functionErrorCode(error);
        const retryable = providerCode === 'GENERATION_IN_PROGRESS'
            || status === undefined
            || RETRYABLE_FUNCTION_STATUSES.has(status)
            || (status >= 500 && status <= 599);
        const message = providerCode === 'DAILY_LIMIT_REACHED'
            ? 'Você já criou o limite de pacotes de hoje. Continue amanhã com uma nova prática.'
            : providerCode === 'PAYMENT_REQUIRED'
                ? 'A geração de novas atividades está pausada enquanto há uma mensalidade em atraso.'
                : providerCode === 'GENERATION_IN_PROGRESS'
                    ? 'Seu pacote já está sendo criado. Aguarde alguns instantes e tente novamente.'
                    : providerCode === 'AI_DISABLED_FOR_TEST_FIXTURE'
                        ? 'A geração por IA está desativada nesta conta de teste.'
                        : retryable
                            ? 'O gerador de atividades está temporariamente indisponível. Tente novamente.'
                            : 'Não foi possível gerar atividades para esta conta.';
        return new ActivityGenerationError(
            message,
            {
                code: providerCode
                    || (retryable ? 'ACTIVITY_GENERATOR_UNAVAILABLE' : 'ACTIVITY_GENERATION_REJECTED'),
                retryable,
                status,
            },
        );
    }
    return new ActivityGenerationError(
        'Não foi possível gerar atividades agora. Tente novamente.',
        { code: 'ACTIVITY_GENERATION_FAILED', retryable: false },
    );
};

export const generateActivities = async (requestKey: string): Promise<GeneratedActivitiesResult> => {
    try {
        const { data, error } = await supabase.functions.invoke('pedagogical-content', {
            body: {
                action: STUDENT_COMPLEMENTARY_ACTION,
                requestKey,
            },
        });

        if (error) throw error;
        const activities = extractSavedActivityArray(data);
        if (!activities) {
            throw new ActivityGenerationError(
                'O servidor não confirmou um pacote seguro de atividades. Tente novamente.',
                { code: 'INVALID_ACTIVITY_RESPONSE', retryable: false },
            );
        }
        const response = asRecord(data);
        return {
            activities,
            source: response?.replay === true || response?.idempotent === true
                ? 'replay'
                : 'server',
            requestKey,
        };
    } catch (generationError) {
        throw await normalizeActivityGenerationError(generationError);
    }
};

export const getPedagogicalSuggestion = async (module: string, _lastContent: string) => {
  const level = module.trim().toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/)?.[1]
    || 'DEFAULT';
  const suggestions: Record<string, string> = {
    A1: 'Hoje, escolha cinco frases úteis da sua rotina, diga cada uma em voz alta e troque uma palavra para criar uma nova versão.',
    A2: 'Conte em inglês algo que aconteceu ontem usando cinco frases. Depois, revise os verbos e repita a história sem ler.',
    B1: 'Pratique explicar uma opinião em três partes: ideia principal, exemplo real e conclusão. Grave um minuto e refaça com mais clareza.',
    B2: 'Escolha um tema do seu interesse, defenda dois pontos de vista opostos e anote conectores que deixem sua fala mais natural.',
    C1: 'Resuma uma ideia complexa em linguagem simples e depois reconstrua o argumento com nuances, exemplos e conectores avançados.',
    C2: 'Reformule a mesma mensagem para três contextos — informal, profissional e persuasivo — observando precisão, tom e naturalidade.',
    DEFAULT: 'Faça uma prática curta e completa: leia algo em inglês, separe três expressões úteis e use cada uma em uma frase dita em voz alta.',
  };
  return suggestions[level];
};

// =============================================================
// LEARNING PATHS BUILDER — AI content generation
// =============================================================
export const generateUnitActivityContent = async (
  briefing: {
    activityType: 'vocab_cards' | 'quiz' | 'grammar_drill' | 'reading' | 'speaking_wolfie';
    unitTitle: string;
    unitDescription?: string;
    targetLevel: string; // A1..C2
    category: string;
    extraInstructions?: string;
  }
): Promise<any> => {
  const { activityType, unitTitle, unitDescription, targetLevel, category, extraInstructions } = briefing;

  const schemaByType: Record<string, string> = {
    vocab_cards: `{
  "cards": [
    { "term": "english word/phrase", "translation": "tradução em pt-BR", "example": "frase de exemplo em inglês" }
  ]
}
Gere 10 cards. Foco no nivel ${targetLevel} e no contexto: ${category}.`,

    quiz: `{
  "questions": [
    { "q": "pergunta em inglês", "options": ["opt1","opt2","opt3","opt4"], "correct": 0, "exp": "explicação curta em pt-BR" }
  ]
}
Gere 5 perguntas multipla escolha. 4 opções cada. Foco em ${targetLevel}.`,

    grammar_drill: `{
  "rule_pt": "explicação concisa da regra gramatical em pt-BR",
  "exercises": [
    { "sentence": "frase com lacuna ___ aqui.", "options": ["opcao1","opcao2"], "correct": 0, "exp": "por que essa opção em pt-BR" }
  ]
}
Gere 5 exercícios. Apenas 2 opções por exercício (foco em escolha A vs B). Nivel ${targetLevel}.`,

    reading: `{
  "text": "texto em inglês de 80-150 palavras adequado ao nivel ${targetLevel} e tema ${category}",
  "questions": [
    { "q": "pergunta de compreensão em inglês ou pt", "options": ["opt1","opt2","opt3","opt4"], "correct": 0, "exp": "explicação curta em pt-BR" }
  ]
}
Gere o texto e 3 perguntas de interpretação.`,

    speaking_wolfie: `{
  "scenario": "identificador_curto_snake_case",
  "instructions_pt": "instruções em pt-BR para o aluno do que ele deve fazer falando (1-2 frases)",
  "target_phrases": ["phrase 1","phrase 2","phrase 3","phrase 4"]
}
Gere o briefing falado adequado ao nivel ${targetLevel} e tema ${category}.`
  };

  const prompt = `Você está criando conteúdo pedagógico para uma trilha de inglês.

UNIDADE: "${unitTitle}"
${unitDescription ? `DESCRIÇÃO DA UNIDADE: ${unitDescription}` : ''}
NÍVEL CEFR: ${targetLevel}
CATEGORIA: ${category}
TIPO DE ATIVIDADE: ${activityType}
${extraInstructions ? `INSTRUÇÕES EXTRAS: ${extraInstructions}` : ''}

Retorne APENAS um JSON válido com este schema EXATO (sem markdown wrappers, sem texto extra):

${schemaByType[activityType]}

Regras importantes:
- Conteúdo 100% alinhado ao nivel ${targetLevel} (vocab, gramática).
- Sem markdown, asteriscos ou bullets dentro dos valores JSON.
- Explicações em pt-BR (campo "exp" ou "explanation_pt") quando aplicável.
- Resposta DEVE ser JSON válido parseável.`;

  try {
    // Usa a edge function dedicada de geração de conteúdo (JSON estrito),
    // NÃO o wolfie-brain (tutor conversacional, que embrulha tudo no schema da persona).
    const { data, error } = await supabase.functions.invoke('pedagogical-content', {
      body: { prompt, studentLevel: targetLevel }
    });
    if (error) throw error;
    // A função já devolve o JSON parseado em `result`; raw é o fallback.
    if (data?.result && typeof data.result === 'object') return data.result;
    const raw = data?.raw || data?.aiText || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI did not return valid JSON');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('generateUnitActivityContent error:', err);
    throw err;
  }
};

export const generateBillingReminder = async (studentName: string, amount: number, dueDate: string, tone: 'friendly' | 'professional' | 'urgent') => {
  try {
    const prompt = `Escreva uma mensagem curta e elegante de lembrete de pagamento para o aluno ${studentName}.
    Valor: R$ ${amount}. Vencimento: ${dueDate}. 
    Tom de voz: ${tone === 'friendly' ? 'Amigável e leve' : tone === 'urgent' ? 'Urgente e sério' : 'Profissional e direto'}. 
    A mensagem deve ser em português, incluir um espaço para o link do boleto/pix e terminar com o nome da escola (use [Nome da Escola]).
Retorne exatamente este JSON, sem campos adicionais:
{"message":"mensagem pronta para envio"}`;

    const { data, error } = await supabase.functions.invoke('pedagogical-content', {
      body: {
        prompt,
        studentLevel: 'B1',
      }
    });

    if (error) throw error;
    if (typeof data?.result?.message === 'string' && data.result.message.trim()) {
      return data.result.message.trim();
    }
    throw new Error('A IA não retornou o lembrete de pagamento.');
  } catch (error) {
    console.error("Billing reminder generation failed:", error instanceof Error ? error.name : "UnknownError");
    return `Olá ${studentName}, lembramos que sua fatura de R$ ${amount} vence em ${dueDate}. Por favor, regularize seu débito.`;
  }
};
