import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HubPersonalization from './HubPersonalization';

vi.mock('./hubService', () => ({
  updateHubPreferences: vi.fn(),
}));

describe('Personalização do membro do Hub', () => {
  it('permite fechar uma edição já concluída pelo botão nativo', () => {
    const onClose = vi.fn();
    render(
      <HubPersonalization
        accountId="11111111-1111-4111-8111-111111111111"
        accountName="Marina"
        audience="LEARNER"
        initial={{ onboarding_completed: true, level: 'B1' }}
        onClose={onClose}
        onComplete={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Fechar personalização' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('permite fechar uma edição já concluída com Escape', () => {
    const onClose = vi.fn();
    render(
      <HubPersonalization
        accountId="11111111-1111-4111-8111-111111111111"
        accountName="Marina"
        audience="EDUCATOR"
        onClose={onClose}
        onComplete={async () => {}}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
