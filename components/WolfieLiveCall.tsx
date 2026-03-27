import React from 'react';
import WolfieTutor from './WolfieTutor';

// ============================================================
// WolfieLiveCall — Now a thin wrapper around unified WolfieTutor
// Opens WolfieTutor directly in voice-first mode (voiceMode=true)
// ============================================================
interface WolfieLiveCallProps {
    user: any;
    topic?: string;
    onClose: () => void;
}

const WolfieLiveCall: React.FC<WolfieLiveCallProps> = ({ user, topic, onClose }) => {
    return (
        <WolfieTutor
            user={user}
            voiceMode={true}
            topic={topic || 'Free Conversation'}
            onClose={onClose}
        />
    );
};

export default WolfieLiveCall;
