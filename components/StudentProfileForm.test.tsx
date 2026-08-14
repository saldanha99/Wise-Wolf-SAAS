import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../services/asaasService', () => ({ asaasService: {} }));
vi.mock('./StudentScheduleManager', () => ({ default: () => null }));

import StudentProfileForm from './StudentProfileForm';

describe('StudentProfileForm', () => {
    it('envia null para Professor Responsavel quando Sem Professor esta selecionado', () => {
        const onSubmit = vi.fn();

        render(
            <StudentProfileForm
                currentUserRole="SCHOOL_ADMIN"
                onSubmit={onSubmit}
                onCancel={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: /salvar perfil/i }));

        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ professor_id: null })
        );
    });
});
