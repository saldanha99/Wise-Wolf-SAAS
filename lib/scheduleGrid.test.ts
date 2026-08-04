import { describe, expect, it } from 'vitest';
import { Reschedule } from '../types';
import { findRescheduleForSlot, reschedulesForTeacherGrid } from './scheduleGrid';

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

const antesDaData = new Date(2026, 6, 20); // 20/07/2026, antes da reposição

describe('reschedulesForTeacherGrid', () => {
    it('não entrega a reposição de um professor para a grade de outro', () => {
        expect(reschedulesForTeacherGrid([damaris], MATEUS, antesDaData)).toEqual([]);
    });

    it('entrega a reposição para o professor dono', () => {
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, antesDaData)).toHaveLength(1);
    });

    it('sem professor selecionado não mostra nada (não cai na lista inteira da escola)', () => {
        expect(reschedulesForTeacherGrid([damaris], undefined, antesDaData)).toEqual([]);
    });

    it("reposição 'Pendente' não ocupa horário na grade", () => {
        const pendente = { ...damaris, date: 'Pendente', time: 'Pendente' };
        expect(reschedulesForTeacherGrid([pendente], FLAVIO, antesDaData)).toEqual([]);
    });

    it('reposição já vencida some da grade (é pendência, não aula marcada)', () => {
        const depois = new Date(2026, 7, 4); // 04/08/2026
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, depois)).toEqual([]);
    });

    it('reposição do próprio dia continua ocupando o horário', () => {
        const noDia = new Date(2026, 6, 23);
        expect(reschedulesForTeacherGrid([damaris], FLAVIO, noDia)).toHaveLength(1);
    });
});

describe('findRescheduleForSlot', () => {
    const daGrade = reschedulesForTeacherGrid([damaris], FLAVIO, antesDaData);

    it('cai na QUINTA (col. 3), não na quarta — data é local, não UTC', () => {
        expect(findRescheduleForSlot(daGrade, 3, '08:00')?.studentName).toBe(damaris.studentName);
        expect(findRescheduleForSlot(daGrade, 2, '08:00')).toBeNull();
    });

    it('não invade outro horário do mesmo dia', () => {
        expect(findRescheduleForSlot(daGrade, 3, '09:00')).toBeNull();
    });

    it('aceita data em DD/MM/AAAA (formato que a tela também produz)', () => {
        const br = reschedulesForTeacherGrid([{ ...damaris, date: '23/07/2026' }], FLAVIO, antesDaData);
        expect(findRescheduleForSlot(br, 3, '08:00')?.studentName).toBe(damaris.studentName);
    });

    it('reposição sem horário não ocupa célula nenhuma', () => {
        const semHora = reschedulesForTeacherGrid([{ ...damaris, time: undefined }], FLAVIO, antesDaData);
        expect(findRescheduleForSlot(semHora, 3, '14:00')).toBeNull();
    });
});
