import { describe, it, expect } from 'vitest';
import { canUseManagementTool, managementGroupParticipant, managementConfirmationMatches, MANAGEMENT_TOOL_POLICIES } from '../supabase/functions/_shared/management-action-policy';
const group = '120363000000000000@g.us';
const incoming = { key: { remoteJid: group, participant: '5551999999999@s.whatsapp.net', id: 'message123', fromMe: false } };
describe('management group authorization', () => {
  it('allows every supported action for a verified participant without a profile', () => {
    for (const actionType of Object.keys(MANAGEMENT_TOOL_POLICIES)) expect(canUseManagementTool({ profileRole: null, membershipRole: null, verifiedGroupMember: true, actionType })).toBe(true);
    expect(canUseManagementTool({ profileRole: null, membershipRole: null, verifiedGroupMember: true, actionType: 'delete_database' })).toBe(false);
  });
  it('preserves ordinary role restrictions outside the authorized group', () => {
    expect(canUseManagementTool({ profileRole: 'TEACHER', membershipRole: 'TEACHER', actionType: 'conta_pagar' })).toBe(false);
    expect(canUseManagementTool({ membershipRole: 'COORDINATOR', profileRole: null, actionType: 'ajuste_repasse' })).toBe(false);
  });
  it('recognizes group authors and stable LID identities', () => {
    expect(managementGroupParticipant(incoming, group)).toBe(incoming.key.participant);
    const key = { ...incoming.key, participant: '123456789012345@lid', participantAlt: incoming.key.participant };
    expect(managementGroupParticipant({ key }, group)).toBe('123456789012345@lid');
    expect(managementGroupParticipant({ key: { ...key, participant: key.participantAlt, participantAlt: key.participant } }, group)).toBe('123456789012345@lid');
  });
  it('rejects other groups, direct messages, outgoing echoes and display-name impersonation', () => {
    expect(managementGroupParticipant(incoming, '120363111111111111@g.us')).toBeNull();
    expect(managementGroupParticipant(incoming, incoming.key.participant)).toBeNull();
    expect(managementGroupParticipant({ key: { ...incoming.key, fromMe: true } }, group)).toBeNull();
    expect(managementGroupParticipant({ key: { remoteJid: group, id: 'x' }, sender: incoming.key.participant, pushName: 'Diretor' }, group)).toBeNull();
  });
  it('requires the same participant for confirmation even with no user account', () => {
    const base = { requestedUserId: null, confirmingUserId: null, requestedJid: incoming.key.participant };
    expect(managementConfirmationMatches({ ...base, confirmingJid: incoming.key.participant })).toBe(true);
    expect(managementConfirmationMatches({ ...base, confirmingJid: '123456789012345@lid' })).toBe(false);
    expect(managementConfirmationMatches({ ...base, requestedJid: null, confirmingJid: null })).toBe(false);
  });
});
