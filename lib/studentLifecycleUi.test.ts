import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canPreserveExactlyOneCurrentMonthInvoice,
  isConfirmedOrReceivedCurrentMonthStatus,
  noNewChargePolicy,
  saoPauloCalendarDate,
} from './studentLifecycleUi';

describe('student lifecycle UI policy', () => {
  it('reconhece cobranças confirmadas ou recebidas, inclusive status legados', () => {
    expect(isConfirmedOrReceivedCurrentMonthStatus('confirmed')).toBe(true);
    expect(isConfirmedOrReceivedCurrentMonthStatus('received')).toBe(true);
    expect(isConfirmedOrReceivedCurrentMonthStatus('RECEIVED_IN_CASH')).toBe(true);
    expect(isConfirmedOrReceivedCurrentMonthStatus('PAGO')).toBe(true);
    expect(isConfirmedOrReceivedCurrentMonthStatus('paid')).toBe(true);
    expect(isConfirmedOrReceivedCurrentMonthStatus('PENDING')).toBe(false);
    expect(noNewChargePolicy(true)).toBe('CHARGE_CURRENT_MONTH');
  });

  it('dispensa a competência quando ela ainda não foi liquidada', () => {
    expect(noNewChargePolicy(false)).toBe('WAIVE_CURRENT_MONTH');
  });

  it('não autoriza preservar uma cobrança sem prova local da identidade Asaas', () => {
    const invoice = {
      id: '6a000000-0000-4000-8000-000000000001',
      value: 169,
      dueDate: '2026-08-10',
      status: 'CONFIRMED',
      providerStatus: 'CONFIRMED',
      asaasPaymentId: 'pay_current_month',
      legacyAsaasPaymentId: 'pay_current_month',
    };

    expect(canPreserveExactlyOneCurrentMonthInvoice([invoice])).toBe(true);
    expect(canPreserveExactlyOneCurrentMonthInvoice([
      { ...invoice, asaasPaymentId: '', legacyAsaasPaymentId: 'pay_legacy' },
    ])).toBe(true);
    expect(canPreserveExactlyOneCurrentMonthInvoice([
      { ...invoice, asaasPaymentId: '', legacyAsaasPaymentId: '' },
    ])).toBe(false);
    expect(canPreserveExactlyOneCurrentMonthInvoice([
      { ...invoice, legacyAsaasPaymentId: 'pay_divergent' },
    ])).toBe(false);
    expect(canPreserveExactlyOneCurrentMonthInvoice([invoice, { ...invoice, id: '6a000000-0000-4000-8000-000000000002' }])).toBe(false);
    expect(canPreserveExactlyOneCurrentMonthInvoice([
      invoice,
      { ...invoice, id: '6a000000-0000-4000-8000-000000000003', status: 'CANCELLED' },
    ])).toBe(true);
    expect(noNewChargePolicy(true, false)).toBeNull();
  });

  it('usa o dia civil de São Paulo mesmo perto da virada em UTC', () => {
    expect(saoPauloCalendarDate(new Date('2026-09-01T01:30:00.000Z'))).toBe('2026-08-31');
    expect(saoPauloCalendarDate(new Date('2026-09-01T03:00:00.000Z'))).toBe('2026-09-01');
  });

  it('mantém a escolha sem nova cobrança disponível após a liquidação do mês', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/StudentsList.tsx'),
      'utf8',
    );

    expect(source).toContain(
      'if (noNewChargeSelectionPolicy) setOffboardingPolicy(noNewChargeSelectionPolicy);',
    );
    expect(source).toContain(".select('id,value,due_date,status,provider_status,asaas_payment_id,asaas_id')");
    expect(source).toContain('!hasConfirmedOrReceivedCurrentInvoice && canPreserveCurrentInvoice');
    expect(source).toContain('Não haverá estorno nem outra cobrança');
    expect(source).toContain('pode ainda estar aguardando crédito no caixa');
    expect(source).not.toContain('mês já liquidado');
  });

  it('explica a diferença operacional entre pausar e encerrar', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'components/StudentsList.tsx'),
      'utf8',
    );

    expect(source).toContain('Os horários fixos serão liberados da agenda do professor');
    expect(source).toContain('Os horários liberados durante a pausa não voltam automaticamente');
    expect(source).toContain('Este é o encerramento definitivo');
  });
});
