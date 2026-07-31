# QA Report: Wise Wolf SaaS multitenant e provisionamento pago

| Field | Value |
|-------|-------|
| **Date** | 2026-07-26 |
| **App URL** | https://system.wisewolflanguage.com.br/new-saas |
| **Sessions** | wise-wolf-saas-local, wise-wolf-saas-production |
| **Release** | 20260726T012935Z-08c5d4b96e2d |
| **Scope** | Landing page SaaS, checkout público, responsividade, console, banco e isolamento multitenant |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 0 |
| **Total** | **3** |

## Validation coverage

- Desktop landing page rendered and navigation anchors validated.
- Pricing CTA, direct paid checkout and demonstration path exercised.
- Production mobile viewport (390 x 844) rendered without browser errors.
- Checkout dialog opened in production without submitting data or creating a
  payment.
- Browser console and page errors inspected.
- PostgreSQL integrity audit confirmed 81 profiles, 81 active memberships and
  81 active tenant contexts, with no orphaned or mismatched tenant records.
- Checkout-intent tables have RLS enabled, no anonymous test artifacts and no
  missing foreign-key indexes.
- Production plans and server-enforced capacity were verified as Starter
  (100 students / 5 teachers), Pro (500 / 25) and Enterprise
  (large-scale high-water marks).

Production evidence:

- `production-new-saas.png`
- `production-plans.png`
- `production-plans-final.png`
- `production-checkout-modal.png`
- `production-new-saas-mobile.png`

## Issues

### ISSUE-001: Paid checkout is unreachable from pricing cards

| Field | Value |
|-------|-------|
| **Severity** | high |
| **Category** | functional / ux |
| **URL** | http://127.0.0.1:4173/new-saas#planos |
| **Repro Video** | videos/issue-001-repro.webm |
| **Status** | Fixed and verified in production |

**Description**

Every pricing-card CTA opens the generic demonstration form. There is no
customer path into the automated paid checkout, so the new payment-confirmed
provisioning flow cannot be reached from the sales page.

**Repro Steps**

1. Open the SaaS landing page.
   ![Step 1](screenshots/issue-001-step-1.png)

2. Navigate to the pricing section and select a plan CTA.
   ![Step 2](screenshots/issue-001-step-2.png)

3. **Observe:** the generic demonstration form opens instead of the selected
   plan checkout.
   ![Result](screenshots/current.png)

**Resolution**

Pricing now comes from the active database plans, supports monthly/yearly
billing and opens the selected paid checkout. Demonstration remains available
as a secondary choice.

### ISSUE-002: Checkout close control has no accessible name

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | accessibility |
| **URL** | http://127.0.0.1:4173/new-saas#planos |
| **Repro Video** | N/A |
| **Status** | Fixed and verified in production |

**Description**

The checkout close icon is exposed to assistive technology as an unnamed
button, and the modal is not announced as a dialog.

**Repro Steps**

1. Open any plan checkout and inspect the annotated controls. Control 5 is an
   unnamed button.
   ![Result](screenshots/issue-002.png)

**Resolution**

The checkout now declares its dialog semantics and provides accessible names
for close and back controls.

### ISSUE-003: Checkout opens without moving or containing keyboard focus

| Field | Value |
|-------|-------|
| **Severity** | medium |
| **Category** | accessibility / ux |
| **URL** | http://127.0.0.1:4173/new-saas#planos |
| **Repro Video** | N/A |
| **Status** | Fixed and verified in production |

**Description**

Opening checkout left keyboard focus on the pricing card behind the modal and
did not contain Tab navigation inside the purchase flow.

**Repro Steps**

1. Open the checkout from a pricing card and continue navigating with the
   keyboard.
   ![Checkout](screenshots/mobile-checkout.png)

**Resolution**

Checkout now focuses its close control on open, traps Tab/Shift+Tab, closes
with Escape, locks background scrolling and restores focus to the originating
control on close.
