import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('teacher access security wiring', () => {
  it('wraps both authenticated app layouts with ProtectedRoute', () => {
    const app = source('../App.tsx');
    expect(app.match(/<ProtectedRoute user=\{user\} onLogout=\{handleLogout\}>/g)).toHaveLength(2);
  });

  it('does not expose the legacy direct-coverage RPC in the admin workflow', () => {
    const panel = source('../components/AdminWorkflowsPanel.tsx');
    expect(panel).not.toContain("rpc('assign_class_coverage'");
    expect(panel).not.toContain('workflow-tab-absences');
  });

  it('describes the secure teacher activation instead of a shared password', () => {
    const management = source('../components/TeacherManagement.tsx');
    expect(management).not.toContain('Senha 123456');
    expect(management).toContain('convite seguro para definir a senha foi enviado');
  });

  it('keeps the migration protections explicit and reviewable', () => {
    const migration = source('../supabase/migrations/20260830120102_harden_teacher_offboarding_and_legacy_coverage.sql');
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
    expect(migration).toContain("lifecycle_status = 'offboarded'");
    expect(migration).toContain("last_error = 'teacher_offboarded'");
    expect(migration).toContain("DELETE FROM auth.sessions WHERE user_id = $1");
  });
});
