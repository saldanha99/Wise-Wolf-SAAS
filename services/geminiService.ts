import { supabase } from '../lib/supabase';

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
