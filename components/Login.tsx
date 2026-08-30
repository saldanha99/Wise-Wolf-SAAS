import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { PROFILE_SAFE_COLS } from '../constants';
import { mapProfileToAppUser } from '../lib/auth-user';
import { User } from '../types';
import { SignInCard2 } from './ui/sign-in-card-2';


interface LoginProps {
  onLogin: (user: User) => void;
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
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('id', authData.user.id)
        .single();

      // O login nunca cria perfil ou tenant. Provisionamento e matrícula usam
      // fluxos server-side autorizados; uma conta órfã deve parar aqui.
      if (profileError || !profile) {
        await supabase.auth.signOut();
        throw new Error('Conta desativada ou perfil não encontrado. Contate o suporte.');
      }

      const user = await mapProfileToAppUser(profile);
      if (!user) {
        await supabase.auth.signOut();
        throw new Error('Conta inativa ou sem acesso a uma instituição. Contate a secretaria.');
      }

      // Check for Redirect (Priority)
      const params = new URLSearchParams(window.location.search);
      const redirectTo = params.get('redirectTo');

      if (redirectTo) {
        window.location.href = redirectTo;
        return;
      }

      onLogin(user);

    } catch (err: any) {
      const invalidCredentials = err?.code === 'invalid_credentials' || err?.message === 'Invalid login credentials';
      if (!invalidCredentials) console.error('Login Error:', err);
      setError(invalidCredentials ? 'E-mail ou senha incorretos.' : (err?.message || 'Erro ao realizar login.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SignInCard2
        onLogin={handleLogin}
        isLoading={loading}
        error={error}
    />
  );
};

export default Login;
