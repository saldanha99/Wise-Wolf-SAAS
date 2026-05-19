import React, { useState, useEffect } from 'react';
import { WolfieOnboarding } from '../../../components/WolfieOnboarding';
import WolfieTutor from '../../../components/WolfieTutor';
import { useStudentContext } from '../../../components/contexts/StudentContext';

const StudentAITutor: React.FC<{ user: any }> = ({ user }) => {
    const { data, refresh } = useStudentContext();
    const [settings, setSettings] = useState<any>(null);

    // Sync settings from context
    useEffect(() => {
        if (data?.profile?.wolfie_settings) {
            setSettings(data.profile.wolfie_settings);
        }
    }, [data]);

    const handleOnboardingComplete = (newSettings: any) => {
        setSettings(newSettings);
        refresh(); // Refresh context so other parts of the app know
    };

    // Volta para a home do aluno
    const handleClose = () => {
        // Mantém compatibilidade com hash routing e fallback genérico
        if (window.location.hash) {
            window.location.hash = '';
        }
        window.location.href = '/';
    };

    if (!settings) {
        return (
            <div className="flex-1 min-h-0 bg-slate-950 rounded-3xl overflow-hidden mt-4">
                <WolfieOnboarding user={user} onComplete={handleOnboardingComplete} />
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-[calc(100vh-100px)] rounded-3xl overflow-hidden mt-4 relative">
            <WolfieTutor user={user} onClose={handleClose} />
        </div>
    );
};

export default StudentAITutor;
