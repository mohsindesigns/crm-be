// Country calling codes + expected national-number digit length, used to give
// phone fields stricter validation than the generic 7-20 char PHONE_RE when the
// value carries a recognizable "+<dial> <digits>" shape (see formFields.js).
// `digits` is either an exact count or a [min, max] range for countries whose
// mobile numbering plan isn't fixed-length. Not exhaustive — anything with an
// unrecognized dial code just falls back to the loose generic rule, so this
// list only needs to cover the countries this agency actually deals with.
//
// Mirrored in crm-fe/src/lib/phoneCountries.ts — keep the two in sync.
const PHONE_COUNTRIES = [
  { iso: 'US', name: 'United States', dial: '1', digits: 10 },
  { iso: 'CA', name: 'Canada', dial: '1', digits: 10 },
  { iso: 'PK', name: 'Pakistan', dial: '92', digits: 10 },
  { iso: 'GB', name: 'United Kingdom', dial: '44', digits: 10 },
  { iso: 'IN', name: 'India', dial: '91', digits: 10 },
  { iso: 'AE', name: 'United Arab Emirates', dial: '971', digits: 9 },
  { iso: 'SA', name: 'Saudi Arabia', dial: '966', digits: 9 },
  { iso: 'AU', name: 'Australia', dial: '61', digits: 9 },
  { iso: 'DE', name: 'Germany', dial: '49', digits: [10, 11] },
  { iso: 'FR', name: 'France', dial: '33', digits: 9 },
  { iso: 'CN', name: 'China', dial: '86', digits: 11 },
  { iso: 'BD', name: 'Bangladesh', dial: '880', digits: 10 },
  { iso: 'LK', name: 'Sri Lanka', dial: '94', digits: 9 },
  { iso: 'NG', name: 'Nigeria', dial: '234', digits: 10 },
  { iso: 'ZA', name: 'South Africa', dial: '27', digits: 9 },
  { iso: 'BR', name: 'Brazil', dial: '55', digits: [10, 11] },
  { iso: 'JP', name: 'Japan', dial: '81', digits: 10 },
  { iso: 'SG', name: 'Singapore', dial: '65', digits: 8 },
  { iso: 'MY', name: 'Malaysia', dial: '60', digits: [9, 10] },
  { iso: 'PH', name: 'Philippines', dial: '63', digits: 10 },
  { iso: 'ID', name: 'Indonesia', dial: '62', digits: [9, 12] },
  { iso: 'TR', name: 'Turkey', dial: '90', digits: 10 },
  { iso: 'EG', name: 'Egypt', dial: '20', digits: 10 },
  { iso: 'QA', name: 'Qatar', dial: '974', digits: 8 },
  { iso: 'KW', name: 'Kuwait', dial: '965', digits: 8 },
  { iso: 'OM', name: 'Oman', dial: '968', digits: 8 },
  { iso: 'BH', name: 'Bahrain', dial: '973', digits: 8 },
  { iso: 'NZ', name: 'New Zealand', dial: '64', digits: [8, 9] },
  { iso: 'IE', name: 'Ireland', dial: '353', digits: 9 },
  { iso: 'IT', name: 'Italy', dial: '39', digits: [9, 10] },
  { iso: 'ES', name: 'Spain', dial: '34', digits: 9 },
  { iso: 'NL', name: 'Netherlands', dial: '31', digits: 9 },
  { iso: 'RU', name: 'Russia', dial: '7', digits: 10 },
  { iso: 'MX', name: 'Mexico', dial: '52', digits: 10 },
  { iso: 'KR', name: 'South Korea', dial: '82', digits: [9, 10] },
];

/** Sorted longest-dial-first so "+1" doesn't shadow-match a longer code that
 *  happens to start with the same digit (none currently do, but keeps this
 *  correct if the list grows). */
const BY_DIAL_LENGTH_DESC = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

/** Checks a "+<dial><rest>" phone value against the expected national digit
 *  count for its dial code. Returns true when the dial code isn't in the
 *  table — callers should fall back to their own generic check in that case,
 *  this only tightens validation for recognized countries. */
function isValidForRecognizedCountry(value) {
  const digitsOnly = String(value || '').replace(/[^\d]/g, '');
  if (!String(value || '').trim().startsWith('+')) return true;
  const match = BY_DIAL_LENGTH_DESC.find((c) => digitsOnly.startsWith(c.dial));
  if (!match) return true;
  const nationalDigits = digitsOnly.slice(match.dial.length).length;
  const [min, max] = Array.isArray(match.digits) ? match.digits : [match.digits, match.digits];
  return nationalDigits >= min && nationalDigits <= max;
}

module.exports = { PHONE_COUNTRIES, isValidForRecognizedCountry };
