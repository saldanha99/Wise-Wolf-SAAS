import { GoogleGenAI } from "@google/genai";

const getRequestConfig = () => {
  // Vite uses import.meta.env, but we keep process.env as fallback
  const apiKey = import.meta.env.VITE_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || (typeof process !== 'undefined' ? process.env.API_KEY : undefined);

  if (!apiKey) {
    console.warn("Gemini API Key missing. Please set VITE_API_KEY in .env");
    return null;
  }
  return new GoogleGenAI({ apiKey });
};

export const getPedagogicalSuggestion = async (module: string, lastContent: string) => {
  try {
    const ai = getRequestConfig();
    if (!ai) return "Configuração de IA ausente. Verifique o console.";

    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash-exp", // Updated to latest available model
      contents: `O aluno está no módulo ${module}. O último conteúdo aplicado foi: "${lastContent}". Sugira um tópico de 1 frase para a próxima aula e uma breve dica pedagógica.`,
      config: {
        temperature: 0.7,
      },
    });
    return response.text;
  } catch (error) {
    console.error("Gemini Suggestion Error:", error);
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
