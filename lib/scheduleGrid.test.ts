import { describe, expect, it } from 'vitest';
import { Reschedule } from '../types';
import {
    dateForDayIndex,
    findRescheduleForSlot,
    findTrialForSlot,
    reschedulesForTeacherGrid,
    trialsForGrid,
    weekStartOf,
} from './scheduleGrid';

const FLAVIO = 'fa2b9980-2c5f-4345-887f-ff6cec79fcd6';
const MATEUS = '11111111-2222-3333-4444-555555555555';

// Dados reais de produção (04/08/2026): a reposição que vazou.
const damaris: Reschedule = {
    id: '18b6c326-870f-475a-a98e-28a74d4995e7',
    date: '2026-07-23', // quinta-feira
    time: '08:00',
    teacherName: 'Flávio Henrique Dias Romão',
    studentName: 'Dâmaris Ferreira Piassi Giuriato',
    repoId: 100,
    originalLessonId: 0,
    teacherId: FLAVIO,
};

// Semana da reposição: segunda 20/07 a sábado 25/07 de 2026.
const semanaDaRepo = weekStartOf(new Date(2026, 6, 23));

describe('weekStartOf', () => {
    it('devolve a segunda-feira da semana', () => {
        expect(dateForDayIndex(weekStartOf(new Date(2026, 6, 23)), 0)).toBe('2026-07-20');
    });

    it('domingo pertence à semana que ACABA nele, não à seguinte', () => {
        // 26/07/2026 é domingo: quem abre a tela no domingo tem de ver a semana
        // que está terminando, senão parece que as aulas da semana sumiram.
        expect(dateForDayIndex(weekStartOf(new Date(2026, 6, 26)), 0)).toBe('2026-07-20');
    });
});

describe('reschedulesForTeacherGrid', () => {
    it('não entrega a reposição de um professor para a grade de outro', () => {
        expect(reschedulesForTeacherGrid([damaris], MATEUS, semanaDaRepo)).toEqual([]);
    });

    it('entrega a reposição para o professor dono', () => {
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, semanaDaRepo)).toHaveLength(1);
    });

    it('sem professor selecionado não mostra nada (não cai na lista inteira da escola)', () => {
        expect(reschedulesForTeacherGrid([damaris], undefined, semanaDaRepo)).toEqual([]);
    });

    it("reposição 'Pendente' não ocupa horário na grade", () => {
        const pendente = { ...damaris, date: 'Pendente', time: 'Pendente' };
        expect(reschedulesForTeacherGrid([pendente], FLAVIO, semanaDaRepo)).toEqual([]);
    });

    it('reposição de semana passada não aparece na semana atual', () => {
        const semanaSeguinte = weekStartOf(new Date(2026, 6, 30));
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, semanaSeguinte)).toEqual([]);
    });

    // A regressão que motivou a âncora de semana: com o casamento por dia da
    // semana, uma reposição futura pintava a célula em TODA semana até a data
    // chegar — e ficava indistinguível de uma aula fixa.
    it('reposição de semana FUTURA não ocupa a semana atual', () => {
        const semanaAnterior = weekStartOf(new Date(2026, 6, 16));
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, semanaAnterior)).toEqual([]);
    });

    it('reposição do próprio dia continua ocupando o horário', () => {
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, semanaDaRepo)).toHaveLength(1);
    });
});

describe('findRescheduleForSlot', () => {
    const daGrade = reschedulesForTeacherGrid([damaris], FLAVIO, semanaDaRepo);

    it('cai na QUINTA (col. 3), não na quarta — data é local, não UTC', () => {
        expect(findRescheduleForSlot(daGrade, 3, '08:00', semanaDaRepo)?.studentName).toBe(damaris.studentName);
        expect(findRescheduleForSlot(daGrade, 2, '08:00', semanaDaRepo)).toBeNull();
    });

    it('não invade outro horário do mesmo dia', () => {
        expect(findRescheduleForSlot(daGrade, 3, '09:00', semanaDaRepo)).toBeNull();
    });

    it('aceita data em DD/MM/AAAA (formato que a tela também produz)', () => {
        const br = reschedulesForTeacherGrid([{ ...damaris, date: '23/07/2026' }], FLAVIO, semanaDaRepo);
        expect(findRescheduleForSlot(br, 3, '08:00', semanaDaRepo)?.studentName).toBe(damaris.studentName);
    });

    it('reposição sem horário não ocupa célula nenhuma', () => {
        const semHora = reschedulesForTeacherGrid([{ ...damaris, time: undefined }], FLAVIO, semanaDaRepo);
        expect(findRescheduleForSlot(semHora, 3, '14:00', semanaDaRepo)).toBeNull();
    });
});

describe('trialsForGrid', () => {
    // `appointments` guarda o horário em start_time (timestamptz) — não existe
    // coluna `date` nem `time`. Construir a partir de uma data LOCAL mantém o
    // teste determinístico em qualquer fuso.
    const quintaAs8 = new Date(2026, 6, 23, 8, 0).toISOString();
    const trial = { id: 'ap-1', start_time: quintaAs8, student_name: 'Lead WhatsApp', status: 'scheduled' };

    it('lê o horário de start_time e cai na célula certa', () => {
        const daSemana = trialsForGrid([trial], semanaDaRepo);
        expect(daSemana).toHaveLength(1);
        expect(findTrialForSlot(daSemana, 3, '08:00', semanaDaRepo)?.studentName).toBe('Lead WhatsApp');
    });

    it('experimental de outra semana não ocupa a grade', () => {
        expect(trialsForGrid([trial], weekStartOf(new Date(2026, 6, 30)))).toEqual([]);
    });

    it('experimental cancelada não ocupa horário', () => {
        expect(trialsForGrid([{ ...trial, status: 'cancelled' }], semanaDaRepo)).toEqual([]);
    });

    it('start_time inválido não quebra a grade', () => {
        expect(trialsForGrid([{ ...trial, start_time: 'nao-e-data' }], semanaDaRepo)).toEqual([]);
    });
});
