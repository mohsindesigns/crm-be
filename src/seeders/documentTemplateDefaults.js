/**
 * Starter document templates so admins can see the correct plain-text + {{token}}
 * shape for quotations, agreements, proposals, and the per-service fragment
 * used inside {{services_block}}.
 *
 * Idempotent: ensureExampleTemplates(orgId) only inserts rows that are missing
 * (matched by type + serviceTypeKey + name).
 */

const { v4: uuidv4 } = require('uuid');

const EXAMPLE_TEMPLATES = [
  {
    type: 'quotation',
    serviceTypeKey: 'standard',
    name: 'Example Quotation (starter)',
    defaultTerms:
      '50% payment is due on acceptance of this quotation. The remaining 50% is due on delivery / go-live. '
      + 'Prices are valid until the date shown above. Work outside this scope will be quoted separately.',
    body: `NOTE: This is a starter template. Edit the wording below, keep the {{tokens}} you need, then rename it (remove "Example").

Dear {{customer_name}},

Thank you for considering {{agency_name}} for {{service}}.

Please find our quotation below for {{business_name}}.

────────────────────────────────
SERVICES & PRICING
────────────────────────────────
{{services_block}}

Subtotal: {{currency}} {{subtotal}}
Discount: {{discount}}
Total investment: {{currency}} {{total}}

Quotation date: {{date}}
Valid until: {{valid_until}}

────────────────────────────────
SCOPE / NOTES
────────────────────────────────
{{scope}}

────────────────────────────────
TERMS
────────────────────────────────
{{terms}}

If you have any questions, reply to this email or call us.

Warm regards,
{{agency_name}}
{{email}} | {{phone}}`,
  },
  {
    type: 'agreement',
    serviceTypeKey: 'standard',
    name: 'Example Agreement (starter)',
    defaultTerms:
      'This agreement becomes binding upon client acceptance. Either party may terminate with 30 days written notice. '
      + 'Fees already paid for completed work are non-refundable. Confidential information shared during the engagement remains confidential.',
    body: `NOTE: This is a starter template. Edit the wording below, keep the {{tokens}} you need, then rename it (remove "Example").

SERVICE AGREEMENT

This Service Agreement ("Agreement") is entered into on {{date}} between:

Service Provider: {{agency_name}}
Client: {{customer_name}}{{business_name}}
Email: {{customer_email}}
Phone: {{customer_phone}}

────────────────────────────────
1. SERVICES
────────────────────────────────
{{agency_name}} agrees to provide the following services:

{{services_block}}

────────────────────────────────
2. FEES & PAYMENT
────────────────────────────────
Total contract value: {{currency}} {{total}}
{{discount}}

Payment schedule and commercial terms are set out under Terms below.

────────────────────────────────
3. TERM & VALIDITY
────────────────────────────────
Agreement date: {{date}}
Valid / start reference: {{valid_until}}

────────────────────────────────
4. SCOPE
────────────────────────────────
{{scope}}

────────────────────────────────
5. TERMS & CONDITIONS
────────────────────────────────
{{terms}}

By accepting this agreement electronically, the Client confirms they have read and agree to the terms above.

Signed for {{agency_name}}
Authorized Signatory`,
  },
  {
    type: 'proposal',
    serviceTypeKey: 'standard',
    name: 'Example Proposal (starter)',
    defaultTerms:
      'This proposal is an offer of services and is not a binding contract until a separate agreement or quotation is accepted. '
      + 'Figures are estimates based on the information shared to date and may be refined after discovery.',
    body: `NOTE: This is a starter template. Edit the wording below, keep the {{tokens}} you need, then rename it (remove "Example").

PROPOSAL FOR {{business_name}}

Prepared for: {{customer_name}}
Prepared by: {{agency_name}}
Date: {{date}}
Valid until: {{valid_until}}

────────────────────────────────
WHY THIS MATTERS
────────────────────────────────
Thank you for the opportunity to propose how {{agency_name}} can support {{business_name}} with {{service}}.

────────────────────────────────
RECOMMENDED APPROACH
────────────────────────────────
{{services_block}}

────────────────────────────────
INVESTMENT SUMMARY
────────────────────────────────
Subtotal: {{currency}} {{subtotal}}
Discount: {{discount}}
Proposed investment: {{currency}} {{total}}

────────────────────────────────
SCOPE OUTLINE
────────────────────────────────
{{scope}}

────────────────────────────────
NEXT STEPS
────────────────────────────────
1. Review this proposal with your team
2. Share any questions or adjustments
3. Accept to proceed to a formal quotation / agreement

────────────────────────────────
TERMS
────────────────────────────────
{{terms}}

We look forward to partnering with you.

{{agency_name}}
{{email}} | {{phone}}`,
  },
  {
    type: 'service_fragment',
    serviceTypeKey: 'standard',
    name: 'Example Service Block (for {{services_block}})',
    defaultTerms: null,
    body: `▸ {{service}}{{package}}
  Investment: {{currency}} {{price}}
{{package_features}}
{{scope}}`,
  },
];

/**
 * Inserts any missing example templates for the org. Safe to call on every
 * Admin → Document Templates list — existing custom templates are untouched.
 */
async function ensureExampleTemplates(orgId, DocumentTemplate) {
  if (!orgId || !DocumentTemplate) return [];
  const created = [];
  for (const tmpl of EXAMPLE_TEMPLATES) {
    const [row, wasCreated] = await DocumentTemplate.findOrCreate({
      where: {
        orgId,
        type: tmpl.type,
        serviceTypeKey: tmpl.serviceTypeKey,
        name: tmpl.name,
      },
      defaults: {
        id: uuidv4(),
        orgId,
        type: tmpl.type,
        serviceTypeKey: tmpl.serviceTypeKey,
        name: tmpl.name,
        body: tmpl.body,
        defaultTerms: tmpl.defaultTerms,
        isActive: true,
      },
    });
    if (wasCreated) created.push(row);
  }
  return created;
}

module.exports = { EXAMPLE_TEMPLATES, ensureExampleTemplates };
