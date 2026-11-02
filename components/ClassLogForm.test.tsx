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
    it('offers the same submit at the end of the list', () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} />);
        const footer = screen.getByRole('button', { name: 'Enviar aulas selecionadas (0)' }) as HTMLButtonElement;
        expect(footer.disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('Resultado da aula de Bia'), { target: { value: 'STUDENT_ABSENCE' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enviar aulas selecionadas (1)' }));
        expect(Object.keys(save.mock.calls[0][0])).toEqual(['two']);
    });
});

describe('Meet prefill', () => {
    const suggestion = { sessionId: 'session', summaryId: 'summary', status: 'PROPOSED' as const, uncertainties: [], fields: {
        lessonObjective: 'Entrevista', lastApplied: 'Passado', studentDifficulties: 'Verbos', homeworkAssigned: 'Exercício 3', recommendedNextStep: 'Simulação',
    } };
    it('prefills notes without selecting attendance and saves after explicit selection', async () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} loadSuggestions={async () => ({ one: suggestion })} />);
        await screen.findByText('Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.');
        expect(screen.getByRole('button', { name: 'Registrar selecionadas (0)' })).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'COMPLETED' } });
        expect(screen.getByText('Preenchido pelo rascunho da reunião — confira os dados')).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Objetivo individual trabalhado — Ana' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save.mock.calls[0][0].one).toMatchObject({ type: 'COMPLETED', ...suggestion.fields });
    });
    it('never replaces typed notes when the asynchronous summary arrives', async () => {
        let resolve!: (value: any) => void;
        const loader = () => new Promise<Record<string, typeof suggestion>>(done => { resolve = done; });
        render(<ClassLogForm items={items} onSave={vi.fn()} loadSuggestions={loader} />);
        fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'COMPLETED' } });
        fireEvent.change(screen.getByLabelText('Objetivo individual trabalhado — Ana'), { target: { value: 'Objetivo corrigido' } });
        resolve({ one: suggestion });
        await screen.findByText('Preenchido pelo rascunho da reunião — confira os dados');
        expect(screen.getByText('Objetivo corrigido')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Editar dados preenchidos' }));
        expect(screen.getByLabelText('Objetivo individual trabalhado — Ana')).toHaveValue('Objetivo corrigido');
    });
    it('missing information stays empty until the teacher supplies it', async () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} loadSuggestions={async () => ({ one: { ...suggestion, fields: { ...suggestion.fields, homeworkAssigned: '', studentDifficulties: '' } } })} />);
        await screen.findByText('Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.');
        fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'COMPLETED' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Sem tarefa combinada' }));
        fireEvent.change(screen.getByLabelText('Dificuldades observadas (ou “nenhuma observada”) — Ana'), { target: { value: 'Pr' } });
        expect(screen.getByLabelText('Dificuldades observadas (ou “nenhuma observada”) — Ana')).toHaveValue('Pr');
        fireEvent.click(screen.getByRole('button', { name: 'Nenhuma dificuldade observada' }));
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save.mock.calls[0][0].one).toMatchObject({ homeworkAssigned: 'Sem tarefa combinada', studentDifficulties: 'Nenhuma dificuldade observada' });
    });
});

it('removes an automatic suggestion that becomes unavailable on refresh while keeping a human edit', async () => {
    const loader = vi.fn().mockResolvedValueOnce({ one: { sessionId: 's', summaryId: 'v', status: 'VERIFIED', uncertainties: [], fields: { lessonObjective: 'Objetivo automático', lastApplied: 'Conteúdo automático' } } }).mockResolvedValueOnce({});
    render(<ClassLogForm items={items} onSave={vi.fn()} loadSuggestions={loader} />);
    await screen.findByText('Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.');
    fireEvent.change(screen.getByLabelText('Resultado da aula de Ana'), { target: { value: 'COMPLETED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Editar dados preenchidos' }));
    fireEvent.change(screen.getByLabelText('Objetivo individual trabalhado — Ana'), { target: { value: 'Objetivo humano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar resumos' }));
    await screen.findByText(/Ainda não há resumo disponível desta aula/);
    expect(screen.getByLabelText('Objetivo individual trabalhado — Ana')).toHaveValue('Objetivo humano');
    expect(screen.getByLabelText('Conteúdo e material realmente trabalhados — Ana')).toHaveValue('');
});
