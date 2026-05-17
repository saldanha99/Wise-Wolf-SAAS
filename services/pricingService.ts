import { supabase } from '../lib/supabase';

export type Duration = 12 | 6 | 1;
export type Frequency = 2 | 3 | 4 | 5;
export type PricingMatrix = Record<number, Record<number, number>>;

// Fallback caso a tabela student_pricing_plans esteja vazia para o tenant.
// Mantido em codigo para nao quebrar fluxos legados durante migracao.
const FALLBACK_PRICING: PricingMatrix = {
    12: { 2: 139.90, 3: 187.00, 4: 271.00, 5: 297.00 },
    6:  { 2: 188.00, 3: 251.00, 4: 345.00, 5: 366.00 },
    1:  { 2: 220.00, 3: 290.00, 4: 390.00, 5: 450.00 },
};

let cache: Map<string, PricingMatrix> = new Map();

export const pricingService = {
    /**
     * Carrega a matriz de precos do tenant.
     * Faz cache em memoria para a sessao atual.
     */
    async loadPricing(tenantId: string): Promise<PricingMatrix> {
        if (!tenantId) return FALLBACK_PRICING;
        if (cache.has(tenantId)) return cache.get(tenantId)!;

        try {
            const { data, error } = await supabase
                .from('student_pricing_plans')
                .select('classes_per_week, fidelity_months, monthly_price, active')
                .eq('tenant_id', tenantId)
                .eq('active', true);

            if (error) throw error;

            if (!data || data.length === 0) {
                cache.set(tenantId, FALLBACK_PRICING);
                return FALLBACK_PRICING;
            }

            // Merge: comeca com fallback e sobrescreve com o que houver no banco
            const matrix: PricingMatrix = {
                12: { ...FALLBACK_PRICING[12] },
                6:  { ...FALLBACK_PRICING[6] },
                1:  { ...FALLBACK_PRICING[1] },
            };

            data.forEach(row => {
                const d = row.fidelity_months as Duration;
                const f = row.classes_per_week as Frequency;
                if (matrix[d]) {
                    matrix[d][f] = parseFloat(row.monthly_price as any);
                }
            });

            cache.set(tenantId, matrix);
            return matrix;
        } catch (err) {
            console.warn('[pricingService] Falha ao carregar do DB, usando fallback:', err);
            return FALLBACK_PRICING;
        }
    },

    /** Busca preco especifico (duracao x frequencia). */
    async getPrice(tenantId: string, duration: Duration, frequency: Frequency): Promise<number> {
        const matrix = await this.loadPricing(tenantId);
        return matrix[duration]?.[frequency] ?? 0;
    },

    /** Limpa o cache (util quando admin edita precos). */
    clearCache(tenantId?: string) {
        if (tenantId) cache.delete(tenantId);
        else cache.clear();
    },

    FALLBACK_PRICING,
};
