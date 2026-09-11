import { describe, it, expect } from 'vitest';
import { verifiedLegacySubscriptionPayment } from '../supabase/functions/asaas-webhook/legacy-subscription-origin';
const expected = { studentId:'00000000-0000-4000-8000-000000000001',customerId:'cus_expected',subscriptionId:'sub_expected' };
const payment = { id:'pay_fixture',customer:expected.customerId,subscription:expected.subscriptionId,status:'RECEIVED',value:229,dueDate:'2026-09-10',paymentDate:'2026-09-09',externalReference:null };
const subscription = { id:expected.subscriptionId,customer:expected.customerId,status:'ACTIVE',externalReference:null };
const input = { eventName:'PAYMENT_RECEIVED',eventPayment:payment,authoritativePayment:payment,authoritativeSubscription:subscription,expected };
describe('legacy recurring settlement origin', () => {
 it('accepts a freshly verified settlement of the already bound subscription',()=>expect(verifiedLegacySubscriptionPayment(input)).toBe(true));
 it('rejects other customers, subscriptions, payment IDs, values and dates',()=>{
  for(const change of [{customer:'cus_other'},{subscription:'sub_other'},{id:'pay_other'},{value:230},{dueDate:'2026-10-10'},{paymentDate:'2026-09-08'},{status:'PENDING'},{deleted:true}]) {
   expect(verifiedLegacySubscriptionPayment({...input,authoritativePayment:{...payment,...change}})).toBe(false);
  }
 });
 it('never treats an unknown external reference or missing parent binding as legacy',()=>{
  for(const key of ['eventPayment','authoritativePayment','authoritativeSubscription'] as const) expect(verifiedLegacySubscriptionPayment({...input,[key]:{...input[key],externalReference:'another-product'}})).toBe(false);
  expect(verifiedLegacySubscriptionPayment({...input,expected:{...expected,subscriptionId:''}})).toBe(false);
  expect(verifiedLegacySubscriptionPayment({...input,authoritativeSubscription:{...subscription,customer:'cus_other'}})).toBe(false);
  expect(verifiedLegacySubscriptionPayment({...input,eventName:'PAYMENT_CREATED'})).toBe(false);
  expect(verifiedLegacySubscriptionPayment({...input,authoritativePayment:{...payment,externalReference:{}}})).toBe(false);
  expect(verifiedLegacySubscriptionPayment({...input,expected:{...expected,studentId:'-'.repeat(36)}})).toBe(false);
 });
});
