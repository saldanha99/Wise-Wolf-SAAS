import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EvolutionView from './EvolutionView';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { from },
}));

// Mock dos subcomponentes visuais pesados (Radar e AIReportCard)
vi.mock('./CompetencyRadarChart', () => ({
  default: () => <div data-testid="radar-chart">Radar Chart</div>,
}));

vi.mock('./AIReportCard', () => ({
  default: ({ studentId }: { studentId: string }) => (
    <div data-testid="ai-report-card">AI Report for {studentId}</div>
  ),
}));

describe('<EvolutionView />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exibe o feedback real do professor quando houver observações em class_logs', async () => {
    const mockClassLogs = [
      {
        observations: 'Gabriela teve excelente desempenho em conversação hoje!',
        notes: null,
        content: 'Simple Past Practice',
        class_date: '2026-09-01',
        created_at: '2026-09-01T15:00:00Z',
        teacher: { full_name: 'Professor Carlos' },
      },
    ];

    from.mockImplementation((table: string) => {
      if (table === 'class_logs') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: mockClassLogs, error: null }),
        };
      }
      if (table === 'student_skill_scores') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    render(<EvolutionView user={{ id: 'a908688f-b0cb-42cc-ad01-72fd3711bc0f' }} />);

    await waitFor(() => {
      expect(
        screen.getByText('"Gabriela teve excelente desempenho em conversação hoje!"')
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/Professor Carlos/i)).toBeInTheDocument();
    expect(screen.queryByText(/Julia está muito mais confiante/i)).not.toBeInTheDocument();
  });

  it('exibe mensagem orientadora amigável e sem citar "Julia" quando não há feedbacks', async () => {
    from.mockImplementation((table: string) => {
      if (table === 'class_logs') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      if (table === 'student_skill_scores') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    });

    render(<EvolutionView user={{ id: 'a908688f-b0cb-42cc-ad01-72fd3711bc0f' }} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Seus feedbacks e apontamentos pedagógicos das aulas aparecerão aqui/i)
      ).toBeInTheDocument();
    });

    expect(screen.queryByText(/Julia/i)).not.toBeInTheDocument();
  });
});
