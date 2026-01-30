import { supabase } from '../lib/supabase';

export const asaasService = {
    syncStudent: async (studentData: {
        user_id: string;
        name: string;
        email: string;
        cpf: string;
        phone: string;
        postalCode: string;
        address: string;
        addressNumber: string;
    }) => {
        try {
            console.log('Syncing student to Asaas:', studentData);
            const { data, error } = await supabase.functions.invoke('sync-student-asaas', {
                body: studentData
            });

            if (error) {
                throw error;
            }

            // Handle "Soft Errors" (200 OK but success: false)
            if (data && data.success === false) {
                console.warn('Asaas Sync Soft Error:', data);
                throw data; // This object has { error: "...", asaasErrors: [] }
            }

            console.log('Asaas Sync Result:', data);
            return data;
        } catch (error) {
            console.error('Error syncing with Asaas:', error);
            throw error;
        }
    },

    createSubscription: async (data: {
        user_id: string;
        value: number;
        dueDay: number;
        billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
        planDuration?: 'RECURRENT' | 'SEMESTER' | 'ANNUAL';
        creditCard?: {
            holderName: string;
            number: string;
            expiryMonth: string;
            expiryYear: string;
            ccv: string;
        };
    }) => {
        try {
            console.log('Creating Asaas Subscription:', { ...data, creditCard: data.creditCard ? '***' : undefined });

            // Using fetch directly to handle 400 errors with custom messages
            const { data: sessionData } = await supabase.auth.getSession();
            const token = sessionData.session?.access_token;

            // Get the project URL from the supabase client (internal property) or env
            // @ts-ignore - 'supabaseUrl' property availability check
            const projectUrl = supabase.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL;

            if (!projectUrl) throw new Error("Supabase URL not found");

            const response = await fetch(`${projectUrl}/functions/v1/create-asaas-subscription`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(data)
            });

            const responseData = await response.json();

            if (!response.ok) {
                // Pega a mensagem de erro do Backend ou usa uma genérica
                const errorMessage = responseData.error || responseData.message || 'Erro ao processar pagamento.';
                console.error("❌ Erro no Service:", errorMessage);

                // LANÇA O ERRO PARA O COMPONENTE PEGAR
                throw new Error(errorMessage);
            }

            console.log('Subscription Result:', responseData);

            // Defense in Depth: Catch "Soft Errors" that might be returned as 200
            if (responseData && responseData.success === false) {
                const msg = responseData.error || "Erro ao processar assinatura.";
                throw new Error(msg);
            }

            return responseData;

        } catch (error: any) {
            console.error('Error creating subscription:', error);
            // Re-throw the error ensuring it's an Error object
            throw error instanceof Error ? error : new Error(error.message || String(error));
        }
    }
};
