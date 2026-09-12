import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ClassLogForm from './ClassLogForm';

afterEach(cleanup);
const items = [{ id: 'one', name: 'Ana', date: 'Hoje às 14:00' }, { id: 'two', name: 'Bia', date: 'Hoje às 15:00' }];
describe('explicit lesson registration', () => {
    it('does not infer completed lessons from displayed rows', () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} />);
        const button = screen.getByRole('button', { name: 'Registrar selecionadas (0)' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
        expect(save).not.toHaveBeenCalled();
    });
    it('search cannot select hidden or untouched rows', () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} />);
        fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'STUDENT_ABSENCE' } });
        fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: 'Bia' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(Object.keys(save.mock.calls[0][0])).toEqual(['one']);
        expect(save.mock.calls[0][0].one.type).toBe('STUDENT_ABSENCE');
    });
    it('requires actual structured teaching notes before submitting completed lesson', () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} />);
        fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'COMPLETED' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(screen.getByRole('alert').textContent).toContain('Ana');
        expect(save).not.toHaveBeenCalled();
        const fields = [
            ['Objetivo individual trabalhado — Ana', 'Entrevista profissional'],
            ['Conteúdo e material realmente trabalhados — Ana', 'Perguntas no passado, material 3'],
            ['Dificuldades observadas (ou “nenhuma observada”) — Ana', 'Verbos irregulares'],
            ['Tarefa combinada (ou “sem tarefa”) — Ana', 'Sem tarefa'],
            ['Próximo passo — Ana', 'Simular entrevista'],
        ];
        fields.forEach(([label, value]) => fireEvent.change(screen.getByLabelText(label), { target: { value } }));
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save.mock.calls[0][0].one).toMatchObject({ type: 'COMPLETED', lastApplied: 'Perguntas no passado, material 3', recommendedNextStep: 'Simular entrevista' });
    });
    it('requires a reason for retroactive attendance without inventing content', () => {
        const save = vi.fn();
        render(<ClassLogForm items={[{ ...items[0], isLate: true }]} onSave={save} />);
        fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'TEACHER_ABSENCE' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('Motivo do lançamento retroativo — Ana'), { target: { value: 'Sem acesso à plataforma ontem' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save.mock.calls[0][0].one).toMatchObject({ lateLoggingReason: 'Sem acesso à plataforma ontem', lastApplied: '' });
    });
});
