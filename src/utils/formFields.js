const { LEAD_FORM_FIELD_TYPES } = require('../config/constants');
const { isValidForRecognizedCountry } = require('./phoneCountries');

// Shared definition/validation layer for every user-built form in the app —
// lead-capture forms (LeadForm/LeadService) and the client requirement forms
// staff email out from a project (RequirementFormTemplate/ClientRequest) both
// render the same field types through the same frontend component
// (crm-fe LeadFormRenderer), so they must agree on exactly what a field
// definition is and what counts as a valid answer. This module is the single
// source of truth for both halves; neither service reimplements it.

// Loose enough to not fight real-world formatting (extensions, spaces,
// dashes), strict enough to reject obvious junk like "abc" or a single digit.
// Mirrored in crm-fe LeadFormRenderer's PHONE_PATTERN — keep the two in sync.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Validates and normalizes the field list a form is built from. Never trusts
 *  client-supplied `key`s blindly — they become the storage keys on every
 *  submission this form ever receives, so duplicates/blank keys are rejected
 *  up front rather than corrupting stored answers later. */
function normalizeFields(rawFields) {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw badRequest('A form needs at least one field.');
  }
  const seenKeys = new Set();
  return rawFields.map((f, i) => {
    const label = String(f?.label || '').trim();
    if (!label) throw badRequest(`Field ${i + 1} needs a label.`);
    const type = String(f?.type || 'text').trim();
    if (!LEAD_FORM_FIELD_TYPES.includes(type)) {
      throw badRequest(`Field "${label}" has an unsupported type "${type}".`);
    }
    const key = String(f?.key || label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `field_${i + 1}`;
    if (seenKeys.has(key)) throw badRequest(`Duplicate field key "${key}" — give each field a unique label.`);
    seenKeys.add(key);
    const options = type === 'select'
      ? (Array.isArray(f?.options) ? f.options.map(String).filter(Boolean) : [])
      : undefined;
    if (type === 'select' && (!options || options.length === 0)) {
      throw badRequest(`Field "${label}" is a dropdown but has no options.`);
    }
    return { key, label, type, required: !!f?.required, hidden: !!f?.hidden, ...(options ? { options } : {}) };
  });
}

/** Validates submitted answers against a form's field definitions and returns
 *  the cleaned answer map keyed by field `key`. Callers layer their own
 *  interpretation on top (LeadService pulls out name/email/phone from it). */
function validateAnswers(fields, answers) {
  const fieldData = {};
  for (const field of fields || []) {
    // Hidden fields never render on the public form, so a visitor can never
    // answer them — skip validation entirely rather than blocking every
    // submission on a required field nobody could see.
    if (field.hidden) continue;
    const raw = answers?.[field.key];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (field.required && (value === undefined || value === null || value === '')) {
      throw badRequest(`"${field.label}" is required.`);
    }
    if (field.type === 'select' && value && !field.options?.includes(value)) {
      throw badRequest(`"${value}" is not a valid option for "${field.label}".`);
    }
    if (field.type === 'email' && value && !EMAIL_RE.test(value)) {
      throw badRequest(`"${field.label}" must be a valid email address.`);
    }
    if (field.type === 'phone' && value && !PHONE_RE.test(value)) {
      throw badRequest(`"${field.label}" must be a valid phone number.`);
    }
    // A value carrying a recognized "+<country dial code>" is checked against
    // that country's expected digit count too — PHONE_RE alone is loose enough
    // to admit e.g. a US number 3 digits short. Unrecognized dial codes (or no
    // "+") skip this and rely on PHONE_RE alone, see phoneCountries.js.
    if (field.type === 'phone' && value && !isValidForRecognizedCountry(value)) {
      throw badRequest(`"${field.label}" doesn't match the expected length for that country code.`);
    }
    if (value !== undefined && value !== null && value !== '') {
      fieldData[field.key] = value;
    }
  }
  return fieldData;
}

module.exports = { normalizeFields, validateAnswers, EMAIL_RE, PHONE_RE, badRequest };
