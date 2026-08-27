/**
 * Starter document templates so admins can see the correct {{token}} shape
 * for quotations, agreements, proposals, and the per-service fragment used
 * inside {{services_block}}.
 *
 * quotation/agreement/proposal bodies (and defaultTerms) are rich-text HTML —
 * they're authored/edited through the WYSIWYG editor (Admin → Quotes &
 * Agreements) and rendered with real headings/bold, not a monospace dump —
 * see utils/htmlSanitizer.js and utils/richTextPdf.js. service_fragment stays
 * plain {{token}} text (it only ever fills {{services_block}}).
 *
 * Idempotent: ensureExampleTemplates(orgId) only inserts rows that are missing
 * (matched by type + serviceTypeKey + name).
 */

const { v4: uuidv4 } = require('uuid');

const STARTER_NOTE = '<p><em>NOTE: This is a starter template. Edit the wording below, keep the {{tokens}} you need, then rename it (remove &quot;Example&quot;).</em></p>';

const EXAMPLE_TEMPLATES = [
  {
    type: 'quotation',
    serviceTypeKey: 'standard',
    name: 'Example Quotation (starter)',
    defaultTerms:
      '<p>50% payment is due on acceptance of this quotation. The remaining 50% is due on delivery / go-live. '
      + 'Prices are valid until the date shown above. Work outside this scope will be quoted separately.</p>',
    body: STARTER_NOTE + `
<p>Dear {{customer_name}},</p>
<p>Thank you for considering {{agency_name}} for {{service}}. Please find our quotation below for {{business_name}}.</p>
<h2>Services &amp; Pricing</h2>
<p>{{services_block}}</p>
<p><strong>Subtotal:</strong> {{currency}} {{subtotal}}<br><strong>Discount:</strong> {{discount}}<br><strong>Total investment:</strong> {{currency}} {{total}}</p>
<p>Quotation date: {{date}}<br>Valid until: {{valid_until}}</p>
<h2>Terms</h2>
<p>{{terms}}</p>
<p>If you have any questions, reply to this email or call us.</p>
<p>Warm regards,<br>{{agency_name}}<br>{{email}} | {{phone}}</p>`,
  },
  {
    type: 'agreement',
    serviceTypeKey: 'standard',
    name: 'Example Agreement (starter)',
    defaultTerms:
      '<p>This agreement becomes binding upon client acceptance. Either party may terminate with 30 days written notice. '
      + 'Fees already paid for completed work are non-refundable. Confidential information shared during the engagement remains confidential.</p>',
    body: STARTER_NOTE + `
<h2>Service Agreement</h2>
<p>This Service Agreement (&quot;Agreement&quot;) is entered into on {{date}} between:</p>
<p><strong>Service Provider:</strong> {{agency_name}}<br><strong>Client:</strong> {{customer_name}} {{business_name}}<br><strong>Email:</strong> {{customer_email}}<br><strong>Phone:</strong> {{customer_phone}}</p>
<h2>1. Services</h2>
<p>{{agency_name}} agrees to provide the following services:</p>
<p>{{services_block}}</p>
<h2>2. Fees &amp; Payment</h2>
<p><strong>Total contract value:</strong> {{currency}} {{total}} {{discount}}</p>
<p>Payment schedule and commercial terms are set out under Terms &amp; Conditions below.</p>
<h2>3. Term &amp; Validity</h2>
<p>Agreement date: {{date}}<br>Valid / start reference: {{valid_until}}</p>
<h2>4. Terms &amp; Conditions</h2>
<p>{{terms}}</p>
<p>By accepting this agreement electronically, the Client confirms they have read and agree to the terms above.</p>
<p><strong>Signed for {{agency_name}}</strong><br>Authorized Signatory</p>`,
  },
  {
    type: 'proposal',
    serviceTypeKey: 'standard',
    name: 'Example Proposal (starter)',
    defaultTerms:
      '<p>This proposal is an offer of services and is not a binding contract until a separate agreement or quotation is accepted. '
      + 'Figures are estimates based on the information shared to date and may be refined after discovery.</p>',
    body: STARTER_NOTE + `
<h2>Proposal for {{business_name}}</h2>
<p><strong>Prepared for:</strong> {{customer_name}}<br><strong>Prepared by:</strong> {{agency_name}}<br><strong>Date:</strong> {{date}}<br><strong>Valid until:</strong> {{valid_until}}</p>
<h2>Why This Matters</h2>
<p>Thank you for the opportunity to propose how {{agency_name}} can support {{business_name}} with {{service}}.</p>
<h2>Recommended Approach</h2>
<p>{{services_block}}</p>
<h2>Investment Summary</h2>
<p><strong>Subtotal:</strong> {{currency}} {{subtotal}}<br><strong>Discount:</strong> {{discount}}<br><strong>Proposed investment:</strong> {{currency}} {{total}}</p>
<h2>Next Steps</h2>
<ol>
<li>Review this proposal with your team</li>
<li>Share any questions or adjustments</li>
<li>Accept to proceed to a formal quotation / agreement</li>
</ol>
<h2>Terms</h2>
<p>{{terms}}</p>
<p>We look forward to partnering with you.</p>
<p>{{agency_name}}<br>{{email}} | {{phone}}</p>`,
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

module.exports = { EXAMPLE_TEMPLATES, ensureExampleTemplates, STARTER_NOTE };
