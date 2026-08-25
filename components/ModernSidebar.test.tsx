import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UserRole, type Tenant, type User } from '../types';
import ModernSidebar from './ModernSidebar';

const tenant: Tenant = {
    id: 'tenant-1',
    name: 'Escola Demo',
    domain: 'demo.invalid',
    branding: {
        logoUrl: '',
        faviconUrl: '',
        primaryColor: '#002366',
        secondaryColor: '#d32f2f',
    },
    studentLimit: 100,
    teacherLimit: 10,
};

const teacher: User = {
    id: 'teacher-1',
    tenantId: tenant.id,
    name: 'Professora Demo',
    email: 'teacher@example.invalid',
    role: UserRole.TEACHER,
};

const renderTeacherSidebar = () => {
    const setActiveTab = vi.fn();
    const view = render(
        <ModernSidebar
            tenant={tenant}
            user={teacher}
            activeTab="dashboard"
            setActiveTab={setActiveTab}
            pendingLessonsCount={3}
            onLogout={vi.fn()}
            isOpen
            setIsOpen={vi.fn()}
            isCollapsed={false}
            setIsCollapsed={vi.fn()}
            theme="light"
            toggleTheme={vi.fn()}
        />,
    );

    return { ...view, setActiveTab };
};

describe('ModernSidebar do professor', () => {
    it('prioriza a rotina e deixa financeiro e conta no fim', () => {
        renderTeacherSidebar();

        const menu = screen.getByLabelText('Seções do sistema');
        const itemIds = Array.from(
            menu.querySelectorAll<HTMLElement>('[data-sidebar-menu-item="true"]'),
            (item) => item.dataset.sidebarItemId,
        );

        expect(itemIds).toEqual([
            'dashboard',
            'schedule',
            'lessons',
            'pending',
            'reschedules',
            'students',
            'meeting_links',
            'teacher_workflows',
            'pedagogical',
            'lesson-planner-ai',
            'class_skills',
            'oral-tests',
            'training',
            'wolfie-lab',
            'msg_settings',
            'automation',
            'teacher-financials',
            'invoices',
            'referral',
            'contract_teacher',
        ]);

        expect(Array.from(
            menu.children,
            (element) => element.tagName === 'DIV' ? element.textContent?.trim() : null,
        ).filter(Boolean)).toEqual([
            'Dia a dia',
            'Pedagógico',
            'Comunicação',
            'Financeiro',
            'Conta e carreira',
        ]);
    });

    it('mantém os mesmos ids de rota e expõe atalhos diários no celular', () => {
        const { setActiveTab } = renderTeacherSidebar();
        const menu = screen.getByLabelText('Seções do sistema');

        fireEvent.click(within(menu).getByRole('button', { name: 'Agenda' }));
        fireEvent.click(within(menu).getByRole('button', { name: 'Enviar NFS-e' }));

        expect(setActiveTab).toHaveBeenNthCalledWith(1, 'schedule');
        expect(setActiveTab).toHaveBeenNthCalledWith(2, 'invoices');

        const mobileMenu = screen.getByRole('button', { name: 'Menu' }).parentElement;
        expect(mobileMenu).not.toBeNull();
        expect(Array.from(
            mobileMenu!.querySelectorAll('button'),
            (button) => button.textContent?.trim(),
        )).toEqual(['Início', 'Agenda', 'Lançar Aula', 'Pendentes', 'Menu']);
    });
});
