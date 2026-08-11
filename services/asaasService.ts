import {
    FunctionsFetchError,
    FunctionsHttpError,
    FunctionsRelayError,
} from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type ErrorRecord = Record<string, unknown>;

class AsaasServiceError extends Error {
    readonly code?: string;
    readonly status?: number;
    readonly correlationId?: string;

    constructor(
        message: string,
        details: { code?: string; status?: number; correlationId?: string } = {},
    ) {
        super(message);
        this.name = 'AsaasServiceError';
        this.code = details.code;
        this.status = details.status;
        this.correlationId = details.correlationId;
    }
}

const asRecord = (value: unknown): ErrorRecord | null => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as ErrorRecord
        : null
);

const safeIdentifier = (value: unknown, maxLength = 100): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    return /^[a-z0-9._:-]+$/i.test(normalized) && normalized.length <= maxLength
        ? normalized
        : undefined;
};

const sanitizeMessage = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;

    const sanitized = value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[e-mail oculto]')
        .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[documento oculto]')
        .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[documento oculto]')
        .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[cartão oculto]')
        .replace(/\b(?:bearer|token|api[_ -]?key|senha|password|ccv|cvv)\s*[:=]\s*["']?[^,;}\s"']+/gi, '$1=[oculto]')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (!sanitized) return undefined;
    return sanitized.length > 300 ? `${sanitized.slice(0, 297)}...` : sanitized;
};

const findErrorMessage = (value: unknown, depth = 0): string | undefined => {
    if (depth > 2) return undefined;

    const directMessage = sanitizeMessage(value);
    if (directMessage) return directMessage;

    const record = asRecord(value);
    if (!record) return undefined;

    for (const key of ['error', 'message', 'description', 'detail']) {
        const message = findErrorMessage(record[key], depth + 1);
        if (message) return message;
    }

    for (const key of ['errors', 'asaasErrors']) {
        const collection = record[key];
        if (!Array.isArray(collection)) continue;

        for (const item of collection.slice(0, 3)) {
            const message = findErrorMessage(item, depth + 1);
            if (message) return message;
        }
    }

    return undefined;
};

const readHttpErrorBody = async (error: FunctionsHttpError): Promise<unknown> => {
    const context = error.context as {
        clone?: () => { json?: () => Promise<unknown> };
        json?: () => Promise<unknown>;
    } | null;

    try {
        const readableContext = typeof context?.clone === 'function' ? context.clone() : context;
        return typeof readableContext?.json === 'function'
            ? await readableContext.json()
            : undefined;
    } catch {
        // The response may have no JSON body (or may already have been consumed).
        return undefined;
    }
};

const toSafeError = async (error: unknown, fallbackMessage: string): Promise<AsaasServiceError> => {
    if (error instanceof AsaasServiceError) return error;

    let payload = error;
    let status: number | undefined;
    let transportCode: string | undefined;

    if (error instanceof FunctionsHttpError) {
        const context = asRecord(error.context);
        status = typeof context?.status === 'number' ? context.status : undefined;
        payload = await readHttpErrorBody(error);
        transportCode = 'FUNCTION_HTTP_ERROR';
    } else if (error instanceof FunctionsRelayError) {
        transportCode = 'FUNCTION_RELAY_ERROR';
    } else if (error instanceof FunctionsFetchError) {
        transportCode = 'FUNCTION_FETCH_ERROR';
    }

    const record = asRecord(payload);
    const payloadStatus = typeof record?.status === 'number' ? record.status : undefined;
    const code = safeIdentifier(
        record?.code
        ?? record?.error_code
        ?? record?.processing_error_code
        ?? transportCode,
        64,
    );
    const correlationId = safeIdentifier(
        record?.correlation_id
        ?? record?.correlationId
        ?? record?.request_id
        ?? record?.requestId,
    );

    return new AsaasServiceError(
        findErrorMessage(payload) ?? sanitizeMessage(error instanceof Error ? error.message : undefined) ?? fallbackMessage,
        { code, status: status ?? payloadStatus, correlationId },
    );
};

const logSafeFailure = (operation: string, error: AsaasServiceError): void => {
    // Deliberately omit the response payload, card data and user identifiers.
    console.error(`[Asaas] ${operation} falhou`, {
        code: error.code ?? 'UNCLASSIFIED_ERROR',
        status: error.status,
        correlationId: error.correlationId,
    });
};

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
        // Extended profile fields (optional, for enrollment flow)
        tenant_id?: string;
        monthly_fee?: number;
        due_day?: number;
        class_frequency?: string;
        professor_id?: string | null;
        professor_id_2?: string | null;
        classSchedule?: any[];
        contract_accepted?: boolean;
        documentation_status?: string;
        signature_ip?: string;
        student_signature_url?: string | null;
        signed_document_url?: string | null;
        startDate?: string;
        // Matrícula de dependente: cobrança no CPF do responsável financeiro.
        // Quando is_dependent=true, a edge cria SEMPRE um novo customer ASAAS
        // (cpfCnpj = guardian_cpf) e grava guardian_* sem escrever profiles.cpf.
        is_dependent?: boolean;
        guardian_name?: string;
        guardian_cpf?: string;
        guardian_email?: string;
        guardian_phone?: string;
        guardian_id?: string | null;
    }) => {
        try {
            const { data, error } = await supabase.functions.invoke('sync-student-asaas', {
                body: studentData
            });

            if (error) {
                throw await toSafeError(error, 'Não foi possível sincronizar o cadastro financeiro.');
            }

            // Handle "Soft Errors" (200 OK but success: false)
            if (data && data.success === false) {
                throw await toSafeError(data, 'Não foi possível sincronizar o cadastro financeiro.');
            }

            return data;
        } catch (error) {
            const safeError = await toSafeError(error, 'Não foi possível sincronizar o cadastro financeiro.');
            logSafeFailure('sincronização do cadastro', safeError);
            throw safeError;
        }
    },

    createSubscription: async (data: {
        user_id: string;
        customer?: string;
        value: number;
        dueDay: number;
        billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
        planDuration?: 'ONE_TIME' | 'RECURRENT' | 'SEMESTER' | 'ANNUAL';
        // startDate: YYYY-MM — mês de início da cobrança (billingStartMonth)
        // Se fornecido, o nextDueDate da assinatura será calculado a partir deste mês
        startDate?: string;
        proRata?: boolean;
        proRataValue?: number;
        creditCard?: {
            holderName: string;
            number: string;
            expiryMonth: string;
            expiryYear: string;
            ccv: string;
        };
        creditCardHolderInfo?: {
            name: string;
            email: string;
            cpfCnpj: string;
            postalCode: string;
            addressNumber: string;
            phone: string;
        };
    }) => {
        try {
            const { data: responseData, error } = await supabase.functions.invoke('create-asaas-subscription', {
                body: data
            });

            if (error) {
                throw await toSafeError(error, 'Erro ao processar pagamento.');
            }

            // Handle errors returned as JSON in data
            if (responseData && responseData.error) {
                throw await toSafeError(responseData, 'Erro ao processar pagamento.');
            }

            // Defense in Depth: Catch "Soft Errors" that might be returned as 200
            if (responseData && responseData.success === false) {
                throw await toSafeError(responseData, 'Erro ao processar assinatura.');
            }

            return responseData;

        } catch (error) {
            const safeError = await toSafeError(error, 'Erro ao processar pagamento.');
            logSafeFailure('criação da cobrança', safeError);
            throw safeError;
        }
    },

    getStudentBillingMethod: async (userId: string) => {
        try {
            const { data, error } = await supabase.functions.invoke('update-student-billing-method', {
                body: { action: 'GET', user_id: userId }
            });
            if (error) throw await toSafeError(error, 'Não foi possível consultar a forma de pagamento.');
            if (!data || data.success === false || data.error) {
                throw await toSafeError(data, 'Não foi possível consultar a forma de pagamento.');
            }
            return data as {
                success: true;
                billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
                subscriptionStatus?: string;
            };
        } catch (error) {
            const safeError = await toSafeError(error, 'Não foi possível consultar a forma de pagamento.');
            logSafeFailure('consulta da forma de pagamento', safeError);
            throw safeError;
        }
    },

    updateStudentBillingMethod: async (data: {
        user_id: string;
        billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
        creditCard?: {
            holderName: string;
            number: string;
            expiryMonth: string;
            expiryYear: string;
            ccv: string;
        };
    }) => {
        try {
            const { data: responseData, error } = await supabase.functions.invoke('update-student-billing-method', {
                body: { ...data, action: 'UPDATE' }
            });
            if (error) throw await toSafeError(error, 'Não foi possível atualizar a forma de pagamento.');
            if (!responseData || responseData.success === false || responseData.error) {
                throw await toSafeError(responseData, 'Não foi possível atualizar a forma de pagamento.');
            }
            return responseData as {
                success: true;
                billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
                pendingPaymentsUpdated?: boolean;
                cardChargedNow?: boolean;
                unchanged?: boolean;
            };
        } catch (error) {
            const safeError = await toSafeError(error, 'Não foi possível atualizar a forma de pagamento.');
            logSafeFailure('atualização da forma de pagamento', safeError);
            throw safeError;
        }
    },

    createEnrollmentPix: async () => {
        try {
            const { data, error } = await supabase.functions.invoke('create-enrollment-pix', {
                body: {}
            });

            if (error) {
                throw await toSafeError(error, 'Não foi possível gerar o PIX da matrícula.');
            }
            if (data && data.success === false) {
                throw await toSafeError(data, 'Não foi possível gerar o PIX da matrícula.');
            }

            return data;
        } catch (error) {
            const safeError = await toSafeError(error, 'Não foi possível gerar o PIX da matrícula.');
            logSafeFailure('geração do PIX de matrícula', safeError);
            throw safeError;
        }
    },

    checkPaymentStatus: async (paymentId: string) => {
        // FIX: Antes havia duas invocações (asaas-webhook + create-enrollment-pix) e apenas
        // a segunda era retornada — e ela sempre falhava porque create-enrollment-pix não
        // tratava action='check'. Agora usa apenas create-enrollment-pix com o handler correto.
        try {
            const { data, error } = await supabase.functions.invoke('create-enrollment-pix', {
                body: { action: 'check', paymentId }
            });
            if (error) {
                throw await toSafeError(error, 'Não foi possível consultar o pagamento.');
            }
            if (data && data.success === false) {
                const safeError = await toSafeError(data, 'Não foi possível consultar o pagamento.');
                logSafeFailure('consulta do pagamento', safeError);
                return { success: false };
            }
            return data;
        } catch (error) {
            const safeError = await toSafeError(error, 'Não foi possível consultar o pagamento.');
            logSafeFailure('consulta do pagamento', safeError);
            return { success: false };
        }
    },

    checkOneTimePayment: async (userId: string) => {
        try {
            const { data, error } = await supabase.functions.invoke('create-asaas-subscription', {
                body: { user_id: userId, action: 'check_one_time' }
            });
            if (error) {
                throw await toSafeError(error, 'Não foi possível consultar o pagamento único.');
            }
            if (data && data.success === false) {
                const safeError = await toSafeError(data, 'Não foi possível consultar o pagamento único.');
                logSafeFailure('consulta do pagamento único', safeError);
                return { success: false };
            }
            return data;
        } catch (error) {
            const safeError = await toSafeError(error, 'Não foi possível consultar o pagamento único.');
            logSafeFailure('consulta do pagamento único', safeError);
            return { success: false };
        }
    }
};
