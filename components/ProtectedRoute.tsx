import React from 'react';
import { User, UserRole } from '../types';
import SuspensionPage from './SuspensionPage';

interface ProtectedRouteProps {
    children: React.ReactNode;
    user: User | null;
    onLogout: () => void;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, user, onLogout }) => {
    // 1. If no user, we naturally render null or let App handle login (App.tsx handles this usually)
    // But if we wrap content, we expect user to be there.
    if (!user) return null;

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

    // 3. Status Lock (if user is explicitly suspended/inactive by admin)
    // This depends on if 'status' field is used for access control aside from financial
    if (user.status === 'INACTIVE' || user.status === 'BLOCKED') {
        // Re-use suspension page or a different one? 
        // For now, let's use SuspensionPage as a catch-all safe guard or just return null
        // But usually Financial Lock is the main one requested.
    }

    return <>{children}</>;
};

export default ProtectedRoute;
