import React from 'react';
import {
  WolfiePracticeFlow,
  type WolfieUserSummary,
} from '../../components/wolfie';

interface StudentAITutorProps {
  user: WolfieUserSummary;
}

const StudentAITutor: React.FC<StudentAITutorProps> = ({ user }) => (
  <div className="mt-4 min-h-[calc(100vh-100px)]">
    <WolfiePracticeFlow user={user} />
  </div>
);

export default StudentAITutor;
