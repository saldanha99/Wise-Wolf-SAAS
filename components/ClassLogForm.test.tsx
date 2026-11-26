import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        fireEvent.click(screen.getByRole('button', { name: 'Aluno faltou — Ana' }));
        fireEvent.change(screen.getByLabelText('Buscar aluno'), { target: { value: 'Bia' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(Object.keys(save.mock.calls[0][0])).toEqual(['one']);
        expect(save.mock.calls[0][0].one.type).toBe('STUDENT_ABSENCE');
    });
    it('requires actual structured teaching notes before submitting completed lesson', () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} />);
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Professor faltou — Ana' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Aluno faltou — Bia' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
        expect(screen.getByText('Preenchido pelo rascunho da reunião — confira: ao lançar, o resumo da aula é aprovado com o que você deixar aqui')).toBeInTheDocument();
        expect(screen.queryByRole('textbox', { name: 'Objetivo individual trabalhado — Ana' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (1)' }));
        expect(save.mock.calls[0][0].one).toMatchObject({ type: 'COMPLETED', ...suggestion.fields });
    });
    it('never replaces typed notes when the asynchronous summary arrives', async () => {
        let resolve!: (value: any) => void;
        const loader = () => new Promise<Record<string, typeof suggestion>>(done => { resolve = done; });
        render(<ClassLogForm items={items} onSave={vi.fn()} loadSuggestions={loader} />);
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
        fireEvent.change(screen.getByLabelText('Objetivo individual trabalhado — Ana'), { target: { value: 'Objetivo corrigido' } });
        resolve({ one: suggestion });
        await screen.findByText('Preenchido pelo rascunho da reunião — confira: ao lançar, o resumo da aula é aprovado com o que você deixar aqui');
        expect(screen.getByText('Objetivo corrigido')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Editar dados preenchidos' }));
        expect(screen.getByLabelText('Objetivo individual trabalhado — Ana')).toHaveValue('Objetivo corrigido');
    });
    it('missing information stays empty until the teacher supplies it', async () => {
        const save = vi.fn();
        render(<ClassLogForm items={items} onSave={save} loadSuggestions={async () => ({ one: { ...suggestion, fields: { ...suggestion.fields, homeworkAssigned: '', studentDifficulties: '' } } })} />);
        await screen.findByText('Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.');
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar dados preenchidos' }));
    fireEvent.change(screen.getByLabelText('Objetivo individual trabalhado — Ana'), { target: { value: 'Objetivo humano' } });
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar resumos' }));
    await screen.findByText(/Ainda não há resumo disponível desta aula/);
    expect(screen.getByLabelText('Objetivo individual trabalhado — Ana')).toHaveValue('Objetivo humano');
    expect(screen.getByLabelText('Conteúdo e material realmente trabalhados — Ana')).toHaveValue('');
});

describe('material da aula e resumo na hora', () => {
    const withStudent = [{ id: 'one', name: 'Ana', date: 'Hoje às 14:00', studentId: 'st-ana' }, { id: 'two', name: 'Bia', date: 'Hoje às 15:00', studentId: 'st-bia' }];
    const materials = [{ id: 'm1', title: 'BOOK A1 PART 2', collection: 'BOOK A1', part: 2, label: 'BOOK A1 · Part 2' }];
    const last = { 'st-ana': { materialId: 'm1', title: 'BOOK A1 PART 2', collection: 'BOOK A1', part: 2, reference: 'Unit 3', label: 'BOOK A1 · Part 2 · Unit 3', classDate: '2026-11-23', teacherName: 'Bruna Barros' } };

    it('ao marcar "Aula ocorreu" já vem o livro da última aula, e a parte sugerida pela IA', async () => {
        const loader = vi.fn().mockResolvedValue({ one: { sessionId: 's', summaryId: 'v', status: 'PROPOSED', uncertainties: [], fields: { lessonObjective: 'Obj' }, materialReference: 'Unit 4, página 40' } });
        const save = vi.fn();
        render(<ClassLogForm items={withStudent} onSave={save} loadSuggestions={loader} materials={materials} lastMaterials={last} />);
        await screen.findByText('Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.');
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
        expect(screen.getByText(/Última aula \(23\/11, Bruna\)/)).toBeInTheDocument();
        expect(screen.getByLabelText('Livro ou material — Ana')).toHaveValue('BOOK A1 · Part 2');
        expect(screen.getByLabelText('Onde parou — Ana')).toHaveValue('Unit 4, página 40');
        expect(screen.getByText('Sugerido pelo resumo da aula')).toBeInTheDocument();
    });

    it('material escrito à mão não vira id da biblioteca; nome igual ao da biblioteca vira', () => {
        const save = vi.fn();
        render(<ClassLogForm items={withStudent} onSave={save} materials={materials} />);
        fireEvent.click(screen.getByRole('button', { name: 'Aluno faltou — Bia' }));
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
        fireEvent.change(screen.getByLabelText('Livro ou material — Ana'), { target: { value: 'Apostila própria' } });
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (2)' }));
        expect(save).not.toHaveBeenCalled(); // campos pedagógicos continuam obrigatórios
        fireEvent.change(screen.getByLabelText('Livro ou material — Ana'), { target: { value: 'book a1 · part 2' } });
        ['Objetivo individual trabalhado', 'Conteúdo e material realmente trabalhados', 'Dificuldades observadas (ou “nenhuma observada”)', 'Tarefa combinada (ou “sem tarefa”)', 'Próximo passo']
            .forEach(label => fireEvent.change(screen.getByLabelText(`${label} — Ana`), { target: { value: 'x' } }));
        fireEvent.click(screen.getByRole('button', { name: 'Registrar selecionadas (2)' }));
        expect(save.mock.calls[0][0].one).toMatchObject({ materialId: 'm1' });
    });

    it('"Todas ocorreram" marca só quem ainda não tem resultado', () => {
        const save = vi.fn();
        render(<ClassLogForm items={withStudent} onSave={save} />);
        fireEvent.click(screen.getByRole('button', { name: 'Todas ocorreram' }));
        expect(screen.getByRole('button', { name: 'Aula ocorreu — Ana' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Aula ocorreu — Bia' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('aula sem resumo ainda: "Buscar o resumo agora" pede ao Google e recarrega', async () => {
        const loader = vi.fn()
            .mockResolvedValueOnce({ one: { sessionId: 'sess-1', summaryId: '', status: 'PENDING', fields: {}, uncertainties: [] } })
            .mockResolvedValueOnce({ one: { sessionId: 'sess-1', summaryId: 'v', status: 'PROPOSED', uncertainties: [], fields: { lessonObjective: 'Objetivo da IA' } } });
        const now = vi.fn().mockResolvedValue('READY');
        render(<ClassLogForm items={withStudent} onSave={vi.fn()} loadSuggestions={loader} onSummaryNow={now} />);
        await screen.findByText('Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.');
        fireEvent.click(screen.getByRole('button', { name: 'Aula ocorreu — Ana' }));
        fireEvent.click(screen.getByRole('button', { name: 'Buscar o resumo agora' }));
        await waitFor(() => expect(now).toHaveBeenCalledWith('sess-1'));
        await screen.findByText('Preenchido pelo rascunho da reunião — confira: ao lançar, o resumo da aula é aprovado com o que você deixar aqui');
        expect(loader).toHaveBeenCalledTimes(2);
    });
});
