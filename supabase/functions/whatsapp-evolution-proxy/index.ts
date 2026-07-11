
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || "https://api.2b.app.br";
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || "";

serve(async (req) => {
    // 1. Handle CORS
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        // 2. AUTHENTICATION CHECK
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            throw new Error("Missing Authorization header");
        }

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_ANON_KEY') ?? '',
            { global: { headers: { Authorization: authHeader } } }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            throw new Error("Unauthorized: " + (authError?.message || "User not found"));
        }

        // 3. PARSE BODY
        const { action, instanceName, payload } = await req.json();

        if (!action || !instanceName) {
            throw new Error("Missing action or instanceName");
        }

        console.log(`[WA Proxy] Action: ${action} | Instance: ${instanceName} | User: ${user.email}`);

        // 4. MAP ACTIONS TO ENDPOINTS
        let endpoint = "";
        let method = "GET";
        let body = null;

        switch (action) {
            case 'instance/create':
                endpoint = `${EVOLUTION_API_URL}/instance/create`;
                method = "POST";
                body = JSON.stringify({
                    instanceName: instanceName,
                    token: payload?.token || instanceName,
                    qrcode: true,
                    integration: 'WHATSAPP-BAILEYS'
                });
                break;

            case 'instance/connect':
                endpoint = `${EVOLUTION_API_URL}/instance/connect/${instanceName}`;
                method = "GET";
                break;

            case 'instance/connectionState':
                endpoint = `${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`;
                method = "GET";
                break;

            case 'instance/logout':
                endpoint = `${EVOLUTION_API_URL}/instance/logout/${instanceName}`;
                method = "DELETE";
                break;

            case 'instance/delete':
                endpoint = `${EVOLUTION_API_URL}/instance/delete/${instanceName}`;
                method = "DELETE";
                break;

            case 'message/sendText':
                endpoint = `${EVOLUTION_API_URL}/message/sendText/${instanceName}`;
                method = "POST";
                body = JSON.stringify({
                    number: payload.number,
                    text: payload.text,
                    options: {
                        delay: 1200,
                        presence: "composing",
                        linkPreview: true
                    }
                });
                break;

            default:
                throw new Error(`Unsupported action: ${action}`);
        }

        // 5. EXECUTE REQUEST TO EVOLUTION API
        const response = await fetch(endpoint, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            body
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`[WA Proxy] Evolution API Error:`, data);
            return new Response(JSON.stringify({ error: data.message || "Evolution API failure", details: data }), {
                status: response.status,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
        }

        return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });

    } catch (error: any) {
        console.error(`[WA Proxy] Error:`, error.message);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
});
