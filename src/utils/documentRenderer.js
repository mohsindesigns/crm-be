// Merge-token substitution for customer_document templates. Shared by admin
// preview/send and the public review page/PDF so there is exactly one place
// that knows how {{tokens}} get filled in.

const TOKEN_KEYS = [
  'customer_name', 'business_name', 'customer_email', 'customer_phone',
  'email', 'phone', 'service', 'package',
  'price', 'currency', 'scope', 'terms', 'date', 'valid_until', 'agency_name',
  'agency_email', 'agency_phone',
  'discount', 'services_block', 'subtotal', 'total', 'package_features',
];

// Formats a package's `features` (array of short strings, set in Admin →
// Packages) as a bulleted list for the quote/agreement email — so what's
// included is defined once on the package and every quote using it stays
// consistent, instead of being re-typed by hand per document.
function formatFeatures(features) {
  if (!Array.isArray(features) || features.length === 0) return '';
  return features.map((f) => `  • ${f}`).join('\n');
}

// "10% off" / "$50 off" / '' when no discount was applied — matches the label
// format already used for ClientPackage discounts in the Client Overview UI.
function formatDiscount(discountType, discountValue, currency) {
  const value = parseFloat(discountValue) || 0;
  if (!['percent', 'fixed'].includes(discountType) || value <= 0) return '';
  return discountType === 'percent' ? `${value}% off` : `${currency || 'USD'} ${value} off`;
}

// Builds the token map from a document (plain object or Sequelize instance),
// the org's brand name, and optional related service/package display names.
// `subtotal` is the pre-discount sum of all service prices; `servicesBlock` is
// the pre-rendered per-service section (see CustomerDocumentService._renderBody).
//
// {{email}} / {{phone}} are the AGENCY contact (for "Questions? Reach us at…").
// Prospect contact is {{customer_email}} / {{customer_phone}}.
function buildMergeTokens(document, {
  agencyName,
  agencyEmail,
  agencyPhone,
  serviceName,
  packageName,
  packageFeatures,
  subtotal,
  servicesBlock,
} = {}) {
  const amount = document.amount != null ? Number(document.amount).toFixed(2) : '';
  const customerEmail = document.email || '';
  const customerPhone = document.phone || '';
  const resolvedAgencyEmail = agencyEmail || 'info@mohsindesigns.com';
  const resolvedAgencyPhone = agencyPhone || '';
  return {
    customer_name: document.prospectName || '',
    business_name: document.businessName || '',
    customer_email: customerEmail,
    customer_phone: customerPhone,
    // Agency contact — used in footers / "Reach us at {{email}}"
    email: resolvedAgencyEmail,
    phone: resolvedAgencyPhone,
    agency_email: resolvedAgencyEmail,
    agency_phone: resolvedAgencyPhone,
    service: serviceName || document.serviceTypeKey || '',
    package: packageName || '',
    price: amount,
    currency: document.currency || 'USD',
    scope: document.scopeTerms || '',
    terms: document.scopeTerms || '',
    date: new Date().toISOString().split('T')[0],
    valid_until: document.validUntil || '',
    agency_name: agencyName || 'Mohsin Designs Project Management',
    discount: formatDiscount(document.discountType, document.discountValue, document.currency),
    services_block: servicesBlock || '',
    subtotal: subtotal != null ? Number(subtotal).toFixed(2) : amount,
    total: amount,
    package_features: formatFeatures(packageFeatures),
  };
}

// Fallback per-service block used when no service_fragment template exists for
// a service (and no 'standard' fragment either). Built in code rather than as a
// template so empty package/price/scope lines can be omitted cleanly.
function defaultServiceFragment(t) {
  const lines = [`▸ ${t.service}${t.package ? ` — ${t.package}` : ''}`];
  if (t.price) lines.push(`  Investment: ${t.currency} ${t.price}`);
  if (t.package_features) lines.push('', "  What's included:", t.package_features);
  if (t.scope) lines.push('', t.package_features ? '  Additional notes:' : "  What's included:", `  ${t.scope}`);
  return lines.join('\n');
}

// Replaces every {{token}} occurrence in `body` with its value from `tokens`.
// Unknown tokens are left as-is rather than silently dropped, so a typo in a
// template is visible instead of vanishing.
function renderTemplate(body, tokens) {
  if (!body) return '';
  return body.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? String(tokens[key] ?? '') : match;
  });
}

module.exports = { TOKEN_KEYS, buildMergeTokens, renderTemplate, defaultServiceFragment, formatFeatures, formatDiscount };
