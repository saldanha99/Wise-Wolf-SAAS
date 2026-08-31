import React from 'react';
import { User } from '../types';
import SuspensionPage from './SuspensionPage';

interface ProtectedRouteProps {
    children: React.ReactNode;
    user: User | null;
    onLogout: () => void;
}

function normalizeAccessState(value: unknown): string {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

export function isUserAccessInactive(user: User): boolean {
    const inactiveStates = new Set([
        'inactive', 'inativo', 'blocked', 'bloqueado', 'disabled', 'desativado',
        'suspended', 'suspenso', 'offboarded', 'desligado',
    ]);
    return inactiveStates.has(normalizeAccessState(user.status)) ||
        inactiveStates.has(normalizeAccessState(user.lifecycleStatus));
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, user, onLogout }) => {
    // 1. If no user, we naturally render null or let App handle login (App.tsx handles this usually)
    // But if we wrap content, we expect user to be there.
    if (!user) return null;

    // Estado administrativo sempre prevalece sobre as demais regras. Isso
    // também cobre um usuário que ainda esteja com um access token em memória.
    if (isUserAccessInactive(user)) {
        return <SuspensionPage user={user} onLogout={onLogout} mode="access" />;
    }

    // A restrição financeira do aluno pertence ao StudentProvider. Ele consulta
    // `student-context`, que valida a dívida no servidor e falha fechado quando o
    // estado autoritativo não pode ser obtido. Este guard conserva somente o
    // bloqueio administrativo comum a todos os papéis.

    return <>{children}</>;
};

export default ProtectedRoute;
