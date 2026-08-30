import React from 'react';
import { User, UserRole } from '../types';
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

    // 2. Financial Lock Logic (Only for Students)
    if (user.role === UserRole.STUDENT) {
        const today = new Date();
        const currentDay = today.getDate();

        // HARDCODED RULE: Due Date is always the 10th
        const DUE_DAY = 10;
        const TOLERANCE_DAYS = 7;
        const LOCK_DAY = DUE_DAY + TOLERANCE_DAYS; // Day 17

        // If today is past the tolerance period (e.g. 18th onwards)
        // AND the user is not actively paid/regular
        const isLate = currentDay > LOCK_DAY;
        const isNotActive = user.status_financial && user.status_financial !== 'ACTIVE';

        if (isLate && isNotActive) {
            return <SuspensionPage user={user} onLogout={onLogout} />;
        }
    }

    return <>{children}</>;
};

export default ProtectedRoute;
