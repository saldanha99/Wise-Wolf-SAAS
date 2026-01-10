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

      if (!profile) {
        throw new Error('Perfil não encontrado no banco de dados.');
      }

      // 3. Construct User Object matching App types
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
        hourlyRate: profile.hourly_rate
      };

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
