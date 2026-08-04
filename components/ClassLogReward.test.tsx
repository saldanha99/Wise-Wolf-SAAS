import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ClassLogReward from './ClassLogReward';
import { calcularXp, describeUnpaid, describeSkip, ClassLogResult } from '../lib/classLogRules';

// Regressão do que motivou esta tela: o professor lançava aula e via só
// "Aulas registradas com perfeição", sem nenhum número. E o valor de uma aula
// NUNCA pode ser estimado no cliente — vem da RPC. Os testes abaixo travam as
// duas coisas: o número que aparece é o do servidor, e aula que não paga diz
// isso na cara em vez de fingir festa.

const base = (over: Partial<ClassLogResult> = {}): ClassLogResult => ({
    inserted: 1,
    skipped: 0,
    reschedulesCreated: 0,
    deltaAmount: 8,
    deltaLessons: 1,
    monthAmount: 120,
    monthLessons: 15,
    turboActive: false,
    entries: [{
        ref: 'a', id: 'x1', status: 'lancada', reason: null,
        kind: 'REGULAR', subtype: null, amount: 8, paid: true, unpaidReason: null,
    }],
    ...over,
});

describe('calcularXp', () => {
    it('não dá XP quando nada foi lançado', () => {
        expect(calcularXp([]).total).toBe(0);
    });

    it('premia lançar em dia acima de lançar atrasado', () => {
        const emDia = calcularXp([false]);
        const atrasada = calcularXp([true]);
        expect(emDia.total).toBeGreaterThan(atrasada.total);
        expect(atrasada.total).toBe(10); // atrasada ainda vale a pena lançar
    });

    it('aplica combo a partir de 3 e dobra a partir de 5 aulas', () => {
        expect(calcularXp([true, true]).combo).toBe(1);
        expect(calcularXp([true, true, true]).combo).toBe(1.5);
        expect(calcularXp(Array(5).fill(true)).combo).toBe(2);
        // 5 atrasadas: (5×10 + 0) × 2
        expect(calcularXp(Array(5).fill(true)).total).toBe(100);
    });
});

describe('tradução dos motivos', () => {
    it('explica por que a falta do professor não paga e aponta a saída', () => {
        const msg = describeUnpaid('falta_professor');
        expect(msg).toContain('não é remunerada');
        expect(msg).toContain('reposição'); // o professor precisa saber que dá pra reaver
    });

    it('tem texto para motivo desconhecido em vez de quebrar', () => {
        expect(describeUnpaid('motivo_que_nao_existe')).toBeTruthy();
        expect(describeSkip(null)).toBeTruthy();
    });
});

/** Finge a preferência de movimento do sistema operacional. */
const mockReducedMotion = (reduce: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
        writable: true, configurable: true,
        value: (query: string) => ({
            matches: reduce && query.includes('prefers-reduced-motion'),
            media: query, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        }),
    });
};

afterEach(() => { vi.restoreAllMocks(); });

describe('<ClassLogReward />', () => {
    it('mostra o valor que veio do servidor, não uma estimativa', async () => {
        mockReducedMotion(false);
        render(<ClassLogReward result={base({ deltaAmount: 19 })} xp={calcularXp([false])} onClose={() => {}} />);
        // O contador sobe até o valor da RPC — o que importa é onde ele PARA.
        // Timeout acima da duração da animação (1100ms), senão o teste corre antes do fim.
        await waitFor(() => expect(screen.getByText(/R\$\s*19,00/)).toBeTruthy(), { timeout: 3000 });
    });

    it('respeita prefers-reduced-motion: mostra o valor final sem animar', () => {
        mockReducedMotion(true);
        render(<ClassLogReward result={base({ deltaAmount: 19 })} xp={calcularXp([false])} onClose={() => {}} />);
        expect(screen.getByText(/R\$\s*19,00/)).toBeTruthy();
    });

    it('diz R$ 0,00 COM o motivo quando a aula não entra na folha', () => {
        const result = base({
            deltaAmount: 0,
            deltaLessons: 0,
            entries: [{
                ref: 'a', id: 'x1', status: 'lancada', reason: null,
                kind: 'REGULAR', subtype: null, amount: 0, paid: false,
                unpaidReason: 'falta_professor',
            }],
        });
        render(<ClassLogReward result={result} xp={calcularXp([false])} onClose={() => {}} />);
        expect(screen.getByText(/não é remunerada/)).toBeTruthy();
    });

    it('avisa que a reposição foi gerada — a aula não sumiu', () => {
        render(<ClassLogReward result={base({ reschedulesCreated: 1 })} xp={calcularXp([false])} onClose={() => {}} />);
        expect(screen.getByText(/reposição/i)).toBeTruthy();
    });

    it('tranquiliza sobre duplicata em vez de mostrar erro', () => {
        const result = base({
            inserted: 0, skipped: 1, deltaAmount: 0, deltaLessons: 0,
            entries: [{
                ref: 'a', id: null, status: 'ignorada', reason: 'ja_lancada',
                kind: 'REGULAR', subtype: null, amount: 0, paid: false, unpaidReason: null,
            }],
        });
        render(<ClassLogReward result={result} xp={calcularXp([])} onClose={() => {}} />);
        expect(screen.getByText(/Nada foi duplicado/)).toBeTruthy();
    });

    it('não renderiza nada quando não houve lançamento nem recado', () => {
        const { container } = render(
            <ClassLogReward result={base({ inserted: 0, entries: [] })} xp={calcularXp([])} onClose={() => {}} />
        );
        expect(container.firstChild).toBeNull();
    });
});
