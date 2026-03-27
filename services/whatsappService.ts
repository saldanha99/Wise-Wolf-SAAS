
import { supabase } from '../lib/supabase';

// CONSTANTES GLOBAIS (API KEY DO PORTAINER/MASTER)
const EVOLUTION_API_URL = "https://api.2b.app.br";
const EVOLUTION_API_KEY = "d037768b3d06382756a0d9edecf3e40e";

export const whatsappService = {
    // 1. Create Instance
    async createInstance(tenantId: string, instanceName: string) {
        try {
            // AJUSTE DE NOME (FIX DUPLICIDADE E UNICIDADE)
            // Se já vier com "prof-", mantemos. Se não, adicionamos.
            const baseName = instanceName.toLowerCase().startsWith('prof')
                ? instanceName.toLowerCase()
                : `prof-${instanceName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

            // Adiciona sulfixo aleatório para garantir unicidade: prof-dani-9x2a
            const uniqueName = `${baseName}-${Math.random().toString(36).substring(2, 6)}`;

            console.log(`🚀 Criando instância única: ${uniqueName}`);

            const response = await fetch(`${EVOLUTION_API_URL}/instance/create`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                },
                body: JSON.stringify({
                    instanceName: uniqueName,
                    token: uniqueName,
                    qrcode: true,
                    integration: 'WHATSAPP-BAILEYS'
                })
            });

            const data = await response.json();

            // Tratamento de erro específico para duplicidade (caso raro com sufixo)
            if (!response.ok) {
                if (data?.error === 'Instance already exists') {
                    // Se por milagre cair num hash igual, tentamos de novo ou retornamos erro
                    throw new Error('Nome de instância indisponível. Tente novamente.');
                }
                throw new Error(data.message || 'Failed to create instance');
            }

            return { success: true, instanceName: uniqueName, data };
        } catch (error: any) {
            console.error('Create Instance Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 2. Connect / Get QR Code
    async connectInstance(tenantId: string, instanceName: string) {
        try {
            // Usa as credenciais globais para buscar o QR Code da instância específica
            const response = await fetch(`${EVOLUTION_API_URL}/instance/connect/${instanceName}`, {
                method: 'GET',
                headers: {
                    'apikey': EVOLUTION_API_KEY
                }
            });

            const data = await response.json();

            if (data.base64) {
                return { success: true, qrcode: data.base64 };
            }

            if (data.instance?.state === 'open' || data.instance?.state === 'connected') {
                return { success: true, status: 'connected' };
            }

            return { success: false, data };
        } catch (error: any) {
            console.error('Connect Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 3. Get Status
    async fetchConnectionState(tenantId: string, instanceName: string) {
        try {
            const response = await fetch(`${EVOLUTION_API_URL}/instance/connectionState/${instanceName}`, {
                method: 'GET',
                headers: {
                    'apikey': EVOLUTION_API_KEY
                }
            });
            const data = await response.json();
            return { success: true, state: data.instance?.state || 'disconnected' };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // 4. Send Message
    async sendText(tenantId: string, instanceName: string, number: string, text: string, userId?: string) {
        try {
            // Instâncias criadas com a chave global PODEM ser controladas com a chave global
            // OU com o token específico salvo no banco (recomendado se tiver).
            // Para simplicidade e correção do erro 401, vamos usar a GLOBAL KEY aqui também,
            // pois ela tem permissão de "Super Admin" sobre todas as instâncias.

            const cleanNumber = number.replace(/\D/g, '');
            const finalNumber = cleanNumber.startsWith('55') && cleanNumber.length > 10 ? cleanNumber : `55${cleanNumber}`;

            const response = await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                },
                body: JSON.stringify({
                    number: finalNumber,
                    text: text,
                    linkPreview: true
                })
            });

            const result = await response.json();

            // Log to DB
            if (userId) {
                await supabase.from('whatsapp_logs').insert({
                    user_id: userId,
                    destination: finalNumber,
                    message: text,
                    status: response.ok ? 'sent' : 'error',
                    response_data: result
                });
            }

            return { success: response.ok, data: result };
        } catch (error: any) {
            console.error('Send Text Error:', error);
            return { success: false, error: error.message };
        }
    },

    // 5. Logout
    async logoutInstance(tenantId: string, instanceName: string) {
        try {
            // Nota: O tenantId não é mais usado para buscar config, mas mantemos assinatura para compatibilidade
            await fetch(`${EVOLUTION_API_URL}/instance/logout/${instanceName}`, {
                method: 'DELETE',
                headers: { 'apikey': EVOLUTION_API_KEY }
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // 6. Delete
    async deleteInstance(tenantId: string, instanceName: string) {
        try {
            await fetch(`${EVOLUTION_API_URL}/instance/delete/${instanceName}`, {
                method: 'DELETE',
                headers: { 'apikey': EVOLUTION_API_KEY }
            });
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // Helpers for automated messages
    async sendLessonReminder(tenantId: string, teacherId: string, instanceName: string, studentName: string, studentPhone: string, time: string) {
        const text = `Oi ${studentName}, tudo bem? 👋\n\nPassando para lembrar que nossa aula começa em 1 hora, às *${time}*.\n\nTe espero no link! 📽️`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    },

    async sendRescheduleConfirmation(tenantId: string, teacherId: string, instanceName: string, studentName: string, studentPhone: string, date: string, time: string) {
        const text = `Olá ${studentName}! 🐺\n\nSua reposição na Wise Wolf foi confirmada para o dia *${date}* às *${time}*.\n\nAté lá! 🚀`;
        return this.sendText(tenantId, instanceName, studentPhone, text, teacherId);
    }
};
