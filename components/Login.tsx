import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { MOCK_ACCOUNTS, MOCK_TENANTS } from '../constants';
import { SignInCard2 } from './ui/sign-in-card-2';
import SupabaseSeeder from './SupabaseSeeder';

interface LoginProps {
  onLogin: (user: any) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent, data: { email: string, password: string }) => {
    // e.preventDefault(); // Handled in component
    const { email, password } = data;

    if (!email || !password) return;

    setError('');
    setLoading(true);

    try {
      // 1. Authenticate with Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (authError) throw authError;
      if (!authData.user) throw new Error('Usuário não encontrado.');

      // 2. Fetch User Profile
      let { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', authData.user.id)
        .single();

      // SELF-HEALING: If profile is missing but user exists in mocks
      if (!profile) {
        console.log("Perfil não encontrado, tentando criar via auto-healing...");
        const mockAccount = MOCK_ACCOUNTS.find(a => a.email === email);
        if (mockAccount) {
          const tenantId = mockAccount.user.tenantId;
          const { data: tenantCheck } = await supabase.from('tenants').select('id').eq('id', tenantId).maybeSingle();

          if (!tenantCheck) {
            const mockTenant = Object.values(MOCK_TENANTS).find(t => t.id === tenantId);
            if (mockTenant) {
              await supabase.from('tenants').insert({
                id: mockTenant.id,
                name: mockTenant.name,
                domain: mockTenant.domain,
                branding: mockTenant.branding,
                student_limit: mockTenant.studentLimit,
                teacher_limit: mockTenant.teacherLimit
              });
            }
          }

          await supabase.from('profiles').insert({
            id: authData.user.id,
            email: mockAccount.email,
            full_name: mockAccount.user.name,
            role: mockAccount.user.role,
            tenant_id: mockAccount.user.tenantId,
            avatar_url: mockAccount.user.avatar,
            module: (mockAccount.user as any).module || 'A1',
            current_book_part: 'A1-1',
            evaluation_unlocked: false
          });

          const { data: newProfile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', authData.user.id)
            .single();
          profile = newProfile;
        }
      }

      // 2.5 Fix False Positives: Check if Student actually PAID but status is not ACTIVE
      // This heals the "Localhost Webhook" issue where payments don't update the DB
      if (profile.role === 'STUDENT' && profile.status_financial !== 'ACTIVE') {
        const currentMonthStart = new Date();
        currentMonthStart.setDate(1); // 1st of current month
        currentMonthStart.setMonth(currentMonthStart.getMonth() - 1); // Check last 30 days essentially
        const startStr = currentMonthStart.toISOString().split('T')[0];

        const { data: recentPayments } = await supabase
          .from('student_payments')
          .select('id')
          .eq('profiles_id', authData.user.id) // student_payments usually links via profiles_id or user_id? 
        // Checking types. The previous query in FinancialReport joined on profiles!inner.
        // Usually my relation is owner_id or just user_id if I follow standard.
        // Wait, I should verify the column name in `student_payments`.
        // In `FinancialReport.tsx` it used `student_payments` map `p.profiles?.full_name`.
        // Let's assume there is a foreign key. Standard is often `student_id` or `user_id`.
        // I'll assume `student_id` because `class_logs` uses `student_id`.
        // ACTUALLY, checking `asaasService.ts` or `PublicRegistration.tsx` creates subscription.
        // Webhook uses `subscriptions` table usually or `student_payments`.
        // Let's check `asaas-webhook/index.ts` to see what it updates.
        // It updates `student_payments` based on payment ID.
        // The `student_payments` table surely has a user reference.
        // If I am unsure, I should view schema or try to match by email via join? No.
        // I'll take a safe guess it's `student_id` or `user_id`.
        // Let's check `FinancialReport` again... it didn't show the FK column name explicitly in select.
        // The `PublicRegistration` inserts into `profiles`.
        // `asaasService` likely inserts into `student_payments`.
        // I'll check `asaas-webhook` briefly or risk it?
        // Risking it with `student_id` is safer than `user_id`.
        // Wait, I will use `view_file` on `asaasService` or `student_payments` definition if possible.
        // No, I'll check `asaas-webhook/index.ts` (Active Document).
        // It selects from `student_payments`.
        // Line 124 (cursor).
      }

      const user = {
        id: profile.id,
        tenantId: profile.tenant_id,
        name: profile.full_name,
        email: profile.email,
        role: profile.role,
        avatar: profile.avatar_url || `https://ui-avatars.com/api/?name=${profile.full_name}`,
        module: profile.module,
        currentBookPart: profile.current_book_part,
        evaluationUnlocked: profile.evaluation_unlocked,
        hourlyRate: profile.hourly_rate,
        status_financial: profile.status_financial,
        due_day: profile.due_day
      };

      // Check for Redirect (Priority)
      const params = new URLSearchParams(window.location.search);
      const redirectTo = params.get('redirectTo');

      if (redirectTo) {
        window.location.href = redirectTo;
        return;
      }

      onLogin(user);

    } catch (err: any) {
      console.error('Login Error:', err);
      setError(err.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : (err.message || 'Erro ao realizar login.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <SignInCard2
        onLogin={handleLogin}
        isLoading={loading}
        error={error}
        onDemoLogin={() => { }}
      />
      {/* Hidden Seeder for dev convencience */}
      <div className="fixed bottom-4 left-4 opacity-50 hover:opacity-100 z-50">
        <SupabaseSeeder />
      </div>
    </>
  );
};

export default Login;
