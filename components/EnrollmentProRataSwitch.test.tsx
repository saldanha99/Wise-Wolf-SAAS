import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import EnrollmentProRataSwitch from './EnrollmentProRataSwitch';

describe('EnrollmentProRataSwitch', () => {
    it('permite desativar o pró-rata em um plano recorrente', () => {
        const onCheckedChange = vi.fn();
        render(
            <EnrollmentProRataSwitch
                checked
                label="Cobrar pró-rata"
                onCheckedChange={onCheckedChange}
            />,
        );

        fireEvent.click(screen.getByRole('checkbox', { name: 'Cobrar pró-rata' }));

        expect(onCheckedChange).toHaveBeenCalledWith(false);
    });

    it('mantém o controle indisponível para aula avulsa', () => {
        const onCheckedChange = vi.fn();
        render(
            <EnrollmentProRataSwitch
                checked={false}
                disabled
                label="Cobrar pró-rata"
                onCheckedChange={onCheckedChange}
            />,
        );

        fireEvent.click(screen.getByRole('checkbox', { name: 'Cobrar pró-rata' }));

        expect(onCheckedChange).not.toHaveBeenCalled();
    });
});
