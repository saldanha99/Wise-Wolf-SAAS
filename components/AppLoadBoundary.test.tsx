import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppLoadBoundary } from './AppLoadBoundary';

const BrokenArea = ({ message }: { message: string }) => {
  throw new Error(message);
};

describe('AppLoadBoundary', () => {
  it('recarrega uma vez ao perder um chunk de uma versão anterior', () => {
    const reload = vi.fn(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppLoadBoundary reload={reload}>
        <BrokenArea message="Failed to fetch dynamically imported module: /assets/StudentAITutor-old.js" />
      </AppLoadBoundary>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Atualize a página');
    expect(screen.getByRole('button', { name: 'Atualizar agora' })).toBeInTheDocument();
    consoleError.mockRestore();
  });

  it('não recarrega automaticamente por um erro que não seja de chunk', () => {
    const reload = vi.fn(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <AppLoadBoundary reload={reload}>
        <BrokenArea message="Erro de negócio" />
      </AppLoadBoundary>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível abrir esta área');
    consoleError.mockRestore();
  });
});
