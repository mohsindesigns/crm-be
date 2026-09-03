const xlsx = require('xlsx');
const { GmbProfile, GmbPhoneNumber, GmbAddress, GmbKeywordRank, Project } = require('../models');

function assertProjectAccess(projectId, orgId) {
  return Project.findOne({ where: { id: projectId, orgId } }).then((p) => {
    if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
    return p;
  });
}

function notFound(what) {
  return Object.assign(new Error(`${what} not found`), { status: 404 });
}

const CHILD_ORDER = [['isPrimary', 'DESC'], ['sortOrder', 'ASC'], ['createdAt', 'ASC']];
const RANK_ORDER = [['keyword', 'ASC'], ['checkedOn', 'DESC']];

function profileIncludes() {
  return [
    { association: 'phones', separate: true, order: CHILD_ORDER },
    { association: 'addresses', separate: true, order: CHILD_ORDER },
    { association: 'keywordRanks', separate: true, order: RANK_ORDER },
  ];
}

function withChildren(profile) {
  return GmbProfile.findByPk(profile.id, { include: profileIncludes() });
}

function localDateParts(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The calendar day on the server, as "YYYY-MM-DD" — never toISOString() (see SeoService's note on why: it reads the UTC day, which drifts a day off local for anything imported/entered near midnight). */
function todayLocal() {
  return localDateParts(new Date());
}

/** Accepts a JS Date (xlsx cellDates), an Excel serial number, or a "YYYY-MM-DD"-ish string. */
function parseSheetDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return localDateParts(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const parsed = xlsx.SSF?.parse_date_code?.(raw);
    if (parsed?.y) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    return null;
  }
  const s = String(raw).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function sheetCell(row, ...keys) {
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== '') return row[key];
  }
  const map = Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  for (const key of keys) {
    const v = map[String(key).trim().toLowerCase()];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

function sheetNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Strings only, trimmed, de-duplicated, blanks dropped — every list field on the profile is this shape. */
function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const v of value) {
    const s = String(v == null ? '' : v).trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

async function getProfile(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  const profile = await GmbProfile.findOne({ where: { projectId, orgId }, include: profileIncludes() });
  return profile;
}

/** Creates the profile row on first save; every later save updates it in place. */
async function upsertProfile(projectId, orgId, data) {
  const project = await assertProjectAccess(projectId, orgId);
  if (project.serviceTypeKey !== 'gmb') {
    throw Object.assign(new Error('GMB Profile is only available for GMB projects.'), { status: 400 });
  }

  const serviceAreasTotal = normalizeList(data.serviceAreasTotal);
  const totalSet = new Set(serviceAreasTotal.map((s) => s.toLowerCase()));
  // "Areas we work" can only ever be a subset of the total list — anything typed
  // there that isn't (or no longer is) in the total list is silently dropped.
  const serviceAreasActive = normalizeList(data.serviceAreasActive).filter((s) => totalSet.has(s.toLowerCase()));

  const payload = {
    gmbProfileUrl: data.gmbProfileUrl?.trim() || null,
    websiteUrl: data.websiteUrl?.trim() || null,
    primaryCategories: normalizeList(data.primaryCategories),
    secondaryCategories: normalizeList(data.secondaryCategories),
    serviceAreasTotal,
    serviceAreasActive,
    keywordsPrimary: normalizeList(data.keywordsPrimary),
    keywordsSecondary: normalizeList(data.keywordsSecondary),
    keywordsRanking: normalizeList(data.keywordsRanking),
  };

  let profile = await GmbProfile.findOne({ where: { projectId, orgId } });
  if (profile) {
    await profile.update(payload);
  } else {
    profile = await GmbProfile.create({ orgId, projectId, ...payload });
  }
  return withChildren(profile);
}

async function findProfileForOrg(profileId, orgId) {
  const profile = await GmbProfile.findOne({ where: { id: profileId, orgId } });
  if (!profile) throw notFound('GMB profile');
  return profile;
}

async function addPhone(profileId, orgId, phoneNumber) {
  const profile = await findProfileForOrg(profileId, orgId);
  const value = String(phoneNumber || '').trim();
  if (!value) throw Object.assign(new Error('Phone number is required.'), { status: 400 });
  const count = await GmbPhoneNumber.count({ where: { gmbProfileId: profile.id } });
  await GmbPhoneNumber.create({
    gmbProfileId: profile.id,
    phoneNumber: value,
    isPrimary: count === 0,
    sortOrder: count,
  });
  return withChildren(profile);
}

async function findPhone(id, orgId) {
  const phone = await GmbPhoneNumber.findOne({
    where: { id },
    include: [{ model: GmbProfile, as: 'profile', where: { orgId }, attributes: ['id'] }],
  });
  if (!phone) throw notFound('Phone number');
  return phone;
}

async function updatePhone(id, orgId, phoneNumber) {
  const phone = await findPhone(id, orgId);
  const value = String(phoneNumber || '').trim();
  if (!value) throw Object.assign(new Error('Phone number is required.'), { status: 400 });
  await phone.update({ phoneNumber: value });
  return withChildren(phone.profile);
}

async function deletePhone(id, orgId) {
  const phone = await findPhone(id, orgId);
  const profileId = phone.gmbProfileId;
  await phone.destroy();
  // The active phone was just removed — promote the next one so a profile with
  // any phones left always has exactly one active, same as Company.
  if (phone.isPrimary) {
    const next = await GmbPhoneNumber.findOne({ where: { gmbProfileId: profileId }, order: CHILD_ORDER });
    if (next) await next.update({ isPrimary: true });
  }
  return withChildren({ id: profileId });
}

async function setPrimaryPhone(id, orgId) {
  const phone = await findPhone(id, orgId);
  await GmbPhoneNumber.update({ isPrimary: false }, { where: { gmbProfileId: phone.gmbProfileId } });
  await phone.update({ isPrimary: true });
  return withChildren(phone.profile);
}

async function addAddress(profileId, orgId, address) {
  const profile = await findProfileForOrg(profileId, orgId);
  const value = String(address || '').trim();
  if (!value) throw Object.assign(new Error('Address is required.'), { status: 400 });
  const count = await GmbAddress.count({ where: { gmbProfileId: profile.id } });
  await GmbAddress.create({
    gmbProfileId: profile.id,
    address: value,
    isPrimary: count === 0,
    sortOrder: count,
  });
  return withChildren(profile);
}

async function findAddress(id, orgId) {
  const address = await GmbAddress.findOne({
    where: { id },
    include: [{ model: GmbProfile, as: 'profile', where: { orgId }, attributes: ['id'] }],
  });
  if (!address) throw notFound('Address');
  return address;
}

async function updateAddress(id, orgId, address) {
  const row = await findAddress(id, orgId);
  const value = String(address || '').trim();
  if (!value) throw Object.assign(new Error('Address is required.'), { status: 400 });
  await row.update({ address: value });
  return withChildren(row.profile);
}

async function deleteAddress(id, orgId) {
  const row = await findAddress(id, orgId);
  const profileId = row.gmbProfileId;
  await row.destroy();
  if (row.isPrimary) {
    const next = await GmbAddress.findOne({ where: { gmbProfileId: profileId }, order: CHILD_ORDER });
    if (next) await next.update({ isPrimary: true });
  }
  return withChildren({ id: profileId });
}

async function setPrimaryAddress(id, orgId) {
  const row = await findAddress(id, orgId);
  await GmbAddress.update({ isPrimary: false }, { where: { gmbProfileId: row.gmbProfileId } });
  await row.update({ isPrimary: true });
  return withChildren(row.profile);
}

/** Adds `keyword` to the profile's tracked keywordsRanking list if it isn't already there (case-insensitive). */
async function _ensureKeywordTracked(profile, keyword) {
  const list = Array.isArray(profile.keywordsRanking) ? profile.keywordsRanking : [];
  if (list.some((k) => k.toLowerCase() === keyword.toLowerCase())) return;
  await profile.update({ keywordsRanking: [...list, keyword] });
}

/** One rank check for one keyword. Re-recording the same keyword on the same day corrects that row instead of stacking a duplicate — same rule as SEO's RankSnapshot. */
async function addKeywordRank(profileId, orgId, { keyword, rank, checkedOn }) {
  const profile = await findProfileForOrg(profileId, orgId);
  const kw = String(keyword || '').trim();
  if (!kw) throw Object.assign(new Error('Keyword is required.'), { status: 400 });
  const day = checkedOn || todayLocal();
  const position = rank === null || rank === undefined || rank === '' ? null : sheetNumber(rank);

  await _ensureKeywordTracked(profile, kw);

  const existing = await GmbKeywordRank.findOne({ where: { gmbProfileId: profile.id, keyword: kw, checkedOn: day } });
  if (existing) await existing.update({ rank: position });
  else await GmbKeywordRank.create({ gmbProfileId: profile.id, keyword: kw, rank: position, checkedOn: day });

  return withChildren(profile);
}

async function deleteKeywordRank(id, orgId) {
  const row = await GmbKeywordRank.findOne({
    where: { id },
    include: [{ model: GmbProfile, as: 'profile', where: { orgId }, attributes: ['id'] }],
  });
  if (!row) throw notFound('Ranking entry');
  const profileId = row.gmbProfileId;
  await row.destroy();
  return withChildren({ id: profileId });
}

async function exportKeywordsCsv(projectId, orgId) {
  const project = await assertProjectAccess(projectId, orgId);
  const profile = await GmbProfile.findOne({ where: { projectId, orgId }, include: profileIncludes() });

  const keywords = profile?.keywordsRanking || [];
  const latestByKeyword = new Map();
  for (const r of profile?.keywordRanks || []) {
    const current = latestByKeyword.get(r.keyword);
    if (!current || r.checkedOn > current.checkedOn) latestByKeyword.set(r.keyword, r);
  }

  const headers = ['Keyword', 'Current Rank'];
  const rows = keywords.map((kw) => [kw, latestByKeyword.get(kw)?.rank ?? '']);
  const csv = [headers, ...rows]
    .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  return { csv, project };
}

/**
 * Columns: Keyword (required), Rank/Position (optional), Date (optional,
 * defaults to today). A keyword not already tracked is added to
 * keywordsRanking; a rank value (if present) is recorded as a history entry
 * for that date. Works with .csv or .xlsx — xlsx.read parses both.
 */
async function importKeywordsCsv(projectId, orgId, fileBuffer) {
  const project = await assertProjectAccess(projectId, orgId);
  if (project.serviceTypeKey !== 'gmb') {
    throw Object.assign(new Error('GMB Profile is only available for GMB projects.'), { status: 400 });
  }

  let profile = await GmbProfile.findOne({ where: { projectId, orgId } });
  if (!profile) profile = await GmbProfile.create({ orgId, projectId });

  const wb = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
  if (!rows.length) throw Object.assign(new Error('The file has no data rows.'), { status: 400 });

  let keywordsAdded = 0;
  let ranksRecorded = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const keyword = String(sheetCell(row, 'Keyword', 'keyword') || '').trim();
    if (!keyword) {
      errors.push(`Row ${i + 2}: "Keyword" is required.`);
      continue;
    }

    const before = (profile.keywordsRanking || []).length;
    await _ensureKeywordTracked(profile, keyword);
    await profile.reload();
    if (profile.keywordsRanking.length > before) keywordsAdded += 1;

    const rankRaw = sheetCell(row, 'Rank', 'Current Rank', 'Position', 'rank');
    if (rankRaw != null) {
      const dateRaw = sheetCell(row, 'Date', 'Last Checked', 'date');
      const day = (dateRaw != null ? parseSheetDate(dateRaw) : null) || todayLocal();
      const position = sheetNumber(rankRaw);
      const existing = await GmbKeywordRank.findOne({ where: { gmbProfileId: profile.id, keyword, checkedOn: day } });
      if (existing) await existing.update({ rank: position });
      else await GmbKeywordRank.create({ gmbProfileId: profile.id, keyword, rank: position, checkedOn: day });
      ranksRecorded += 1;
    }
  }

  if (!keywordsAdded && !ranksRecorded && errors.length) {
    throw Object.assign(new Error(errors.slice(0, 6).join(' · ')), { status: 422 });
  }

  return { imported: rows.length - errors.length, keywordsAdded, ranksRecorded, errors, profile: await withChildren(profile) };
}

module.exports = {
  getProfile,
  upsertProfile,
  addPhone,
  updatePhone,
  deletePhone,
  setPrimaryPhone,
  addAddress,
  updateAddress,
  deleteAddress,
  setPrimaryAddress,
  addKeywordRank,
  deleteKeywordRank,
  exportKeywordsCsv,
  importKeywordsCsv,
};
