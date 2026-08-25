import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SchoolSignupPage from './SchoolSignupPage';
import TeacherEntrepreneurSignup from './TeacherEntrepreneurSignup';

const supabaseMocks = vi.hoisted(() => ({
  from: vi.fn(),
  insert: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: supabaseMocks.from,
  },
}));

vi.mock('./marketing/useSystemMarketingMetadata', () => ({
  useSystemMarketingMetadata: vi.fn(),
}));

vi.mock('./hub/HubProductMockups', () => ({
  default: () => <div aria-hidden="true" />,
}));

vi.mock('./hub/HubMarketingShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  HubReveal: ({
    children,
    as: Element = 'div',
    className,
  }: {
    children: React.ReactNode;
    as?: React.ElementType;
    className?: string;
  }) => <Element className={className}>{children}</Element>,
  HubSectionIntro: ({
    eyebrow,
    title,
    description,
  }: {
    eyebrow: string;
    title: React.ReactNode;
    description: string;
  }) => (
    <section>
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  ),
}));

const scrollIntoView = vi.fn();

const getFormSubmit = () => {
  const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]');
  if (!submit) throw new Error('Form submit button was not rendered');
  return submit;
};

describe('diagnosis signup validation accessibility', () => {
  beforeEach(() => {
    supabaseMocks.insert.mockReset();
    supabaseMocks.from.mockReset().mockReturnValue({ insert: supabaseMocks.insert });
    scrollIntoView.mockReset();

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('focuses the first invalid teacher field and exposes field-level guidance without submitting', () => {
    render(<TeacherEntrepreneurSignup />);

    fireEvent.click(getFormSubmit());

    const firstField = screen.getByLabelText('Nome completo *');
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(firstField).toHaveFocus();
    expect(firstField).toHaveAttribute('required');
    expect(firstField).toHaveAttribute('aria-invalid', 'true');
    expect(firstField).toHaveAttribute('aria-describedby', 'teacher-name-error');
    expect(firstField).toHaveAccessibleDescription('Informe seu nome completo.');
    expect(screen.getByRole('alert')).toHaveTextContent('Revise os campos destacados');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });

    fireEvent.change(firstField, { target: { value: 'Maria Professora' } });
    expect(firstField).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Informe seu nome completo.')).not.toBeInTheDocument();
  });

  it('focuses the first invalid school field and marks every required control without submitting', () => {
    render(<SchoolSignupPage />);

    fireEvent.click(getFormSubmit());

    const firstField = screen.getByLabelText('Nome da escola *');
    expect(supabaseMocks.from).not.toHaveBeenCalled();
    expect(firstField).toHaveFocus();
    expect(firstField).toHaveAttribute('required');
    expect(firstField).toHaveAttribute('aria-invalid', 'true');
    expect(firstField).toHaveAttribute('aria-describedby', 'school-name-error');
    expect(firstField).toHaveAccessibleDescription('Informe o nome da escola.');
    expect(screen.getByLabelText('Momento da escola *')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Prioridade inicial *')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Principal gargalo da operação *')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Revise os campos destacados');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
});
