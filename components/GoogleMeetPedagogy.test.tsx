import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoogleMeetSettings from './GoogleMeetSettings';
import LessonPedagogicalSummary from './LessonPedagogicalSummary';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('../lib/googleMeet',()=>({googleMeetAction:invoke}));
beforeEach(()=>invoke.mockReset());
const detail=()=>({session:{documentation_consent:true},room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij'},
  enabled:true,summary_ai_enabled:false,artifacts:[{id:'artifact',kind:'SMART_NOTES',source_text:'Exercícios de inglês.',imported_at:'2026-09-12T12:00:00Z',expires_at:'2026-12-12T12:00:00Z'}],
  summaries:[{id:'draft-id',version:1,status:'PROPOSED',origin:'GOOGLE_SMART_NOTES',content:{narrative:'Exercícios de inglês.',lesson_objective:'',recommended_next_step:'',content_practiced:[],recurring_errors:[],strengths_observed:[],homework_assigned:'',uncertainties:[],evidence:[]}}]});
describe('Google Meet documentation readiness and human review',()=>{
  it('shows setup pending and does not manufacture a connected account or room',async()=>{
    invoke.mockResolvedValue({configured:false,enabled:false,connection:null,can_manage:true,missing_configuration:['GOOGLE_MEET_OAUTH_CLIENT_ID'],summary_ai_enabled:false});
    render(<GoogleMeetSettings tenantId="fixture"/>);
    await screen.findByText('Configuração pendente');
    expect((screen.getByRole('button',{name:'Conectar conta central'}) as HTMLButtonElement).disabled).toBe(true);
    expect(invoke.mock.calls.map(([action])=>action)).toEqual(['status']);
  });
  it('native notes do not become verified facts before an explicit complete review',async()=>{
    invoke.mockImplementation((action)=>Promise.resolve(action==='session_detail'?detail():{ok:true}));
    render(<LessonPedagogicalSummary sessionId="session" tenantId="fixture"/>);
    await screen.findByText('Resumo da aula');
    const approve=screen.getByRole('button',{name:'Aprovar e atualizar memória do aluno'}) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Objetivo trabalhado'),{target:{value:'Pedir direções'}});
    fireEvent.change(screen.getByLabelText('Próximo passo'),{target:{value:'Praticar com um mapa'}});
    fireEvent.click(approve);
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('review_summary',expect.objectContaining({status:'VERIFIED',parentVersionId:'draft-id',content:expect.objectContaining({lesson_objective:'Pedir direções'})})));
  });
  it('does not display approval success when the authoritative endpoint fails',async()=>{
    invoke.mockResolvedValue(detail());
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText('Resumo da aula');
    invoke.mockRejectedValueOnce(new Error('Revisão não salva'));
    fireEvent.click(screen.getByRole('button',{name:'Registrar rejeição'}));
    await screen.findByRole('alert');
    expect(screen.queryByText('Revisão registrada.')).toBeNull();
  });
  it('shows additional API estimate and requires cost acknowledgment before generation',async()=>{
    const data={...detail(),summary_ai_enabled:true,summary_ai_model:'configured-model',summary_ai_pricing:{estimated_usd:0.014,max_output_tokens:6000}};
    invoke.mockResolvedValue(data);
    render(<LessonPedagogicalSummary sessionId="session"/>);
    const button=await screen.findByRole('button',{name:'Gerar rascunho estruturado'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);expect(screen.getByText(/US\$ 0.0140/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button.disabled).toBe(false);
    expect(invoke.mock.calls.map(([action])=>action)).toEqual(['session_detail']);
  });
});
