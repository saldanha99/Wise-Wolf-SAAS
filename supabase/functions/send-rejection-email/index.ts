import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { Resend } from "npm:resend@2.0.0";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RejectionRequest {
    email: string;
    studentName: string;
    reason: string;
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const { email, studentName, reason }: RejectionRequest = await req.json();

        const htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #D32F2F; text-align: center;">Documentação Pendente de Correção</h2>
        <p>Olá, <strong>${studentName}</strong>.</p>
        <p>Identificamos uma inconsistência na sua documentação enviada para o contrato da <strong>Wise Wolf Language</strong>.</p>
        
        <div style="background-color: #fce8e8; padding: 15px; border-left: 4px solid #D32F2F; margin: 20px 0;">
            <p style="margin: 0; font-weight: bold;">Motivo da Rejeição:</p>
            <p style="margin: 5px 0 0 0;">${reason}</p>
        </div>

        <p>Por favor, acesse o portal e reenvie o documento ou assine novamente para regularizar sua matrícula.</p>

        <div style="text-align: center; margin-top: 30px;">
            <a href="https://wise-wolf.com/login" style="background-color: #002366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">Acessar Portal do Aluno</a>
        </div>
        
        <p style="margin-top: 30px; font-size: 12px; color: #777; text-align: center;">
             Se tiver dúvidas, entre em contato com a secretaria.
        </p>
      </div>
    `;

        const data = await resend.emails.send({
            from: "Wise Wolf <nao-responda@wisewolf.com.br>",
            to: [email],
            subject: "⚠️ Ação Necessária: Correção de Documentação",
            html: htmlContent,
        });

        return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
        });
    }
});
