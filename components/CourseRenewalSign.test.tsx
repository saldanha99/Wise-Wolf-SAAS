import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CourseRenewalSign from './CourseRenewalSign';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
const token='a'.repeat(64);
const data={student_name:'Bianca Crepaldi Rodrigues',school_name:'Wise Wolf',term_months:6,monthly_fee_cents:37700,classes_per_week:5,contract_start:'2026-09-15',first_due_date:'2026-09-15',last_due_date:'2027-02-15',service_end_date:'2027-03-15',status:'PENDING_SIGNATURE',billing_status:'NOT_AUTHORIZED',expired:false};
beforeEach(()=>{rpc.mockReset(); window.history.replaceState({},'',`/renovar-curso?token=${token}`);});
describe('CourseRenewalSign',()=>{
  it('shows frozen dates, fee and frequency',async()=>{rpc.mockResolvedValue({data:{ok:true,data},error:null});render(<CourseRenewalSign/>);expect(await screen.findByText('Bianca Crepaldi Rodrigues')).toBeInTheDocument();expect(screen.getByText(/377,00/)).toBeInTheDocument();expect(screen.getByText(/15\/09\/2026 a 15\/03\/2027/)).toBeInTheDocument();});
  it('requires consent and signs idempotently through the token RPC',async()=>{rpc.mockResolvedValueOnce({data:{ok:true,data},error:null}).mockResolvedValueOnce({data:{ok:true,billing_status:'PENDING'},error:null});render(<CourseRenewalSign/>);fireEvent.change(await screen.findByPlaceholderText(data.student_name),{target:{value:data.student_name}});const button=screen.getByRole('button',{name:/Assinar renovação/i});expect(button).toBeDisabled();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(button);expect(await screen.findByText('Renovação assinada')).toBeInTheDocument();expect(rpc).toHaveBeenLastCalledWith('sign_student_course_renewal',{p_token:token,p_typed_signature:data.student_name});});
  it('fails closed for malformed public data',async()=>{rpc.mockResolvedValue({data:{ok:true,data:{...data,term_months:12}},error:null});render(<CourseRenewalSign/>);expect(await screen.findByRole('alert')).toHaveTextContent(/Não foi possível abrir o contrato/);});
});
