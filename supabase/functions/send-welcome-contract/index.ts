import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { Resend } from "npm:resend@2.0.0"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0"

const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim()
const resendFromEmail = Deno.env.get("RESEND_FROM_EMAIL")?.trim()
    || "Wise Wolf <nao-responda@wisewolflanguage.com.br>"
const resendReplyTo = Deno.env.get("RESEND_REPLY_TO")?.trim()
const systemUrl = (Deno.env.get("SYSTEM_URL")?.trim()
    || "https://system.wisewolflanguage.com.br").replace(/\/+$/, "")

interface WelcomeEmailRequest {
    email: string
    name: string
    contractUrl?: string // URL to fetch PDF from (if available)
    contractBase64?: string // OR Base64 content of the PDF
}

interface EmailCaller {
    email: string | null
    isAdmin: boolean
    isService: boolean
}

async function getEmailCaller(req: Request): Promise<EmailCaller | null> {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim()
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || ""
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""

    if (!token || !supabaseUrl || !serviceRoleKey) return null
    if (token === serviceRoleKey) return { email: null, isAdmin: true, isService: true }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return null

    const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle()

    return {
        email: user.email || null,
        isAdmin: ["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(profile?.role || ""),
        isService: false,
    }
}

const logoUrl = Deno.env.get("EMAIL_LOGO_URL")?.trim()
    || "https://wisewolflanguage.com.br/logo.png"

const handler = async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } })
    }

    try {
        const caller = await getEmailCaller(req)
        if (!caller) {
            return new Response(JSON.stringify({ error: "Não autorizado" }), {
                status: 401,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            })
        }

        const { email, name, contractUrl, contractBase64 }: WelcomeEmailRequest = await req.json()
        const isOwnEmail = caller.email?.toLowerCase() === email?.trim().toLowerCase()
        if (!caller.isAdmin && !caller.isService && !isOwnEmail) {
            return new Response(JSON.stringify({ error: "Não autorizado" }), {
                status: 403,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            })
        }

        if (!resendApiKey) {
            throw new Error("RESEND_API_KEY não configurada")
        }

        const resend = new Resend(resendApiKey)

        // Attachments logic
        const attachments = []

        if (contractUrl) {
            attachments.push({
                filename: 'Contrato_WiseWolf.pdf',
                path: contractUrl,
            })
        } else if (contractBase64) {
            attachments.push({
                filename: 'Contrato_WiseWolf.pdf',
                content: contractBase64, // Needs to be buffer or appropriate format for Resend, usually Resend handles base64 content in specific way or Buffer
            })
            // Note: Resend Deno SDK might expect Buffer or specific content. 
            // For simplicity using 'path' with URL is safest if Resend fetches it, 
            // otherwise 'content' as Buffer. 
            // Since we are in Deno, 'content' should be a Buffer.
            // For this code, we'll try to rely on 'path' mainly or leave it as TODO if base64 needed.
        }

        const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Arial', sans-serif; background-color: #f4f4f9; color: #333; margin: 0; padding: 0; }
          .container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .header { background-color: #002366; padding: 30px; text-align: center; }
          .header img { max-width: 150px; }
          .content { padding: 40px 30px; text-align: center; }
          .h1 { color: #002366; font-size: 24px; font-weight: bold; margin-bottom: 20px; }
          .text { font-size: 16px; line-height: 1.6; color: #555; margin-bottom: 30px; }
          .btn-group { display: flex; flex-direction: column; gap: 15px; align-items: center; margin-top: 30px; }
          .btn { display: inline-block; width: 80%; padding: 15px; border-radius: 50px; text-decoration: none; font-weight: bold; text-align: center; font-size: 16px; transition: all 0.3s ease; }
          .btn-primary { background-color: #002366; color: #ffffff; border: 2px solid #002366; }
          .btn-secondary { background-color: #ffffff; color: #002366; border: 2px solid #002366; }
          .btn-accent { background-color: #FF0000; color: #ffffff; border: 2px solid #FF0000; }
          .footer { background-color: #f4f4f9; padding: 20px; text-align: center; font-size: 12px; color: #999; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <!-- Replace with actual public URL of your logo -->
            <img src="${logoUrl}" alt="Wise Wolf Language" />
          </div>
          <div class="content">
            <h1 class="h1">Bem-vindo ao Império! 🐺</h1>
            <p class="text">
              Olá, <strong>${name}</strong>!<br><br>
              Seja muito bem-vindo à <strong>Wise Wolf Language</strong>. É uma honra ter você em nossa alcateia.
              <br><br>
              Seu <strong>contrato de prestação de serviços</strong> já foi processado e segue <strong>em anexo</strong> a este e-mail para sua conferência. Você também pode baixá-lo a qualquer momento em seu portal.
            </p>

            <div class="btn-group">
              <a href="${systemUrl}" class="btn btn-primary">🚀 Acessar Minhas Aulas</a>
              <a href="https://chat.whatsapp.com/SEU_GRUPO_LINK" class="btn btn-secondary">👥 Entrar no Grupo de Alunos</a>
              <a href="https://wa.me/5511971681451" class="btn btn-accent">💬 Falar com Suporte</a>
            </div>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} Wise Wolf Language. Todos os direitos reservados.</p>
            <p>CNPJ: 55.806.029/0001-57</p>
          </div>
        </div>
      </body>
      </html>
    `

        const data = await resend.emails.send({
            from: resendFromEmail,
            to: [email],
            subject: '📄 Seu Contrato - Wise Wolf Language',
            html: htmlContent,
            attachments: attachments.length > 0 ? attachments : undefined,
            ...(resendReplyTo ? { reply_to: resendReplyTo } : {})
        })

        return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        })

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        })
    }
}

serve(handler)
