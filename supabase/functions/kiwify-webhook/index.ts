import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const EVOLUTION_API_URL = Deno.env.get('EVOLUTION_API_URL') || '';
const EVOLUTION_API_KEY = Deno.env.get('EVOLUTION_API_KEY') || '';
const EVOLUTION_INSTANCE = Deno.env.get('EVOLUTION_INSTANCE_NAME') || '';

// URLs of the videos to send (Replace with actual hosted video URLs)
const VIDEOS = {
  cart_abandoned: "https://seu-dominio.com/videos/carrinho-abandonado.mp4",
  welcome: "https://seu-dominio.com/videos/boas-vindas.mp4"
};

// Captions for the videos
const CAPTIONS = {
  cart_abandoned: "Fala, tudo bem? Alex Crepaldi aqui da W-Tech. Cara, vi que você demonstrou interesse no nosso treinamento de Regulagem de Suspensão, mas acabou não finalizando a sua inscrição. \n\nEu sei que esse é um assunto que gera muitas dúvidas, mas dominar o ajuste da moto é o que separa quem anda no limite do risco de quem tem performance com segurança. \n\nAlguma dúvida técnica ou dificuldade no checkout te travou? Me responde aqui! Eu faço questão de te ajudar a entrar nessa turma pra você dominar de vez os cliques da sua suspensão. Bora pra cima!",

  welcome: "Parabéns! Alex Crepaldi aqui pra te dar as boas-vindas oficial ao treinamento de Regulagem de Suspensão da W-Tech. \n\nVocê acaba de tomar a decisão certa pra dominar a ciclística da sua moto ou dos seus clientes. O seu acesso já foi disparado pelo Kiwify pro seu e-mail. Dá uma conferida lá agora! \n\nAssista aos módulos iniciais, entenda a base teórica e se prepare, porque a partir de agora você vai entender exatamente o que cada clique faz na suspensão. Qualquer coisa, o nosso suporte está à disposição. Nos vemos nas aulas!"
};

async function sendWhatsAppVideo(phone: string, videoUrl: string, caption: string) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
    console.error("Evolution API credentials missing in environment variables.");
    return false;
  }

  // Format phone (remove non-digits, ensure 55 prefix for BR)
  let formattedPhone = phone.replace(/\D/g, '');
  if (formattedPhone.length <= 11) {
    formattedPhone = '55' + formattedPhone;
  }

  // Clean trailing slash if present
  const baseUrl = EVOLUTION_API_URL.replace(/\/$/, '');
  const endpoint = `${baseUrl}/message/sendMedia/${EVOLUTION_INSTANCE}`;

  const payload = {
    number: formattedPhone,
    mediatype: "video",
    media: videoUrl,
    fileName: "video.mp4",
    caption: caption,
    delay: 1500
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log("Evolution API Response:", data);
    return response.ok;
  } catch (error) {
    console.error("Error sending WhatsApp video:", error);
    return false;
  }
}

serve(async (req) => {
  try {
    // Check method
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const payload = await req.json();
    console.log("Received Kiwify Webhook:", JSON.stringify(payload));

    const status = payload.order_status;
    const customer = payload.customer || {};
    const phone = customer.mobile;

    if (!phone) {
      return new Response(JSON.stringify({ error: "No phone number provided in payload" }), {
        headers: { "Content-Type": "application/json" },
        status: 400
      });
    }

    let success = false;

    if (status === 'cart_abandoned') {
      console.log(`Sending abandoned cart video to ${phone}`);
      success = await sendWhatsAppVideo(phone, VIDEOS.cart_abandoned, CAPTIONS.cart_abandoned);
    } else if (status === 'paid' || status === 'approved') {
      console.log(`Sending welcome video to ${phone}`);
      success = await sendWhatsAppVideo(phone, VIDEOS.welcome, CAPTIONS.welcome);
    } else {
      console.log(`Ignored status: ${status}`);
      success = true; // Not an error, just ignored
    }

    return new Response(
      JSON.stringify({ success, message: "Webhook processed" }),
      { headers: { "Content-Type": "application/json" } },
    )
  } catch (err: any) {
    console.error("Error processing webhook:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { headers: { "Content-Type": "application/json" }, status: 500 },
    )
  }
})
