import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(COMPONENTS_DIR);

const source = (relativePath: string): string =>
    readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');

describe('rota pedagógica do aluno', () => {
    it('não volta a expor a prova mockada e usa a avaliação autoritativa', () => {
        const app = source('App.tsx');
        const pedagogicalView = source('components/StudentPedagogicalView.tsx');
        const studentMaterials = source('components/StudentMaterials.tsx');
        const routeAndView = `${app}\n${pedagogicalView}`;

        expect(pedagogicalView).not.toContain("import StudentQuizModal from './StudentQuizModal'");
        expect(pedagogicalView).not.toContain('<StudentQuizModal');
        expect(routeAndView).toContain('<StudentMaterials');

        const materialsRoute = app.match(/'materials'\s*:\s*[\s\S]{0,280}?(?=,\s*'reschedules')/)?.[0] ?? '';
        expect(materialsRoute).not.toContain('<StudentQuizModal');

        expect(studentMaterials).not.toContain('StudentQuizModal');
        expect(studentMaterials).not.toContain('PEDAGOGICAL_EVALUATIONS');
        expect(studentMaterials).toContain("functions.invoke('submit-quiz'");
        expect(studentMaterials.replace(/\s+/g, ' ')).not.toMatch(
            /from\(['"]student_quiz_attempts['"]\)\s*\.insert/,
        );
    });
});
