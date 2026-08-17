// Builds the canonical, human-readable project name: client name + service name
// (+ package tier, when the project came from a sold package), so it reads
// correctly everywhere a project is listed (tables, headers, emails) regardless of
// what free-text label (if any) the creator typed.
// e.g. buildProjectName('Platinum Loss Solutions', 'SEO', 'Standard') ->
//      "Platinum Loss Solutions - SEO - Standard"
function buildProjectName(clientName, serviceLabel, packageLabel, note) {
  const base = [clientName, serviceLabel, packageLabel].filter(Boolean).join(' - ');
  const trimmedNote = (note || '').trim();
  return trimmedNote ? `${base} (${trimmedNote})` : base;
}

module.exports = { buildProjectName };
