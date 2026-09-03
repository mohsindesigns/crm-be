const { GmbProfile, GmbServiceArea, Project } = require('../models');

function assertProjectAccess(projectId, orgId) {
  return Project.findOne({ where: { id: projectId, orgId } }).then((p) => {
    if (!p) throw Object.assign(new Error('Project not found'), { status: 404 });
    return p;
  });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const AREA_ORDER = [['areaName', 'ASC']];

function withServiceAreas(profile) {
  return GmbProfile.findByPk(profile.id, {
    include: [{ association: 'serviceAreas', separate: true, order: AREA_ORDER }],
  });
}

/** Strings only, trimmed, de-duplicated (case-insensitive), blanks dropped. Also splits any comma-separated paste into separate entries, per the field spec. */
function normalizeList(value) {
  const raw = Array.isArray(value) ? value : (value == null ? [] : [value]);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    for (const piece of String(item == null ? '' : item).split(',')) {
      const s = piece.trim();
      if (!s || seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out;
}

function normalizeUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`;
  try {
    // eslint-disable-next-line no-new
    new URL(withScheme);
  } catch {
    throw badRequest(`"${s}" is not a valid URL.`);
  }
  return withScheme;
}

async function getProfile(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  return GmbProfile.findOne({
    where: { projectId, orgId },
    include: [{ association: 'serviceAreas', separate: true, order: AREA_ORDER }],
  });
}

/**
 * One PUT saves the whole form — basics, categories, services, and the full
 * service-area list (each area optionally flagged as targeted with its own
 * start date) — in one shot, same as the mockup's single Save action.
 *
 * `mode: 'draft'` skips required-field checks so a partial fill-in can be
 * saved; `mode: 'complete'` runs full validation and marks the profile
 * `status: 'completed'`. Areas are diffed by name (case-insensitive) against
 * what's already stored, rather than requiring the client to track row ids.
 */
async function saveProfile(projectId, orgId, data, { mode = 'draft', userId } = {}) {
  const project = await assertProjectAccess(projectId, orgId);
  if (project.serviceTypeKey !== 'gmb') {
    throw badRequest('GMB Profile is only available for GMB projects.');
  }
  const complete = mode === 'complete';

  const name = String(data.name || '').trim();
  const address = String(data.address || '').trim();
  const contactNumber = String(data.contactNumber || '').trim();
  const services = normalizeList(data.services);
  const primaryCategory = String(data.primaryCategory || '').trim();
  const secondaryCategories = normalizeList(data.secondaryCategories)
    .filter((c) => c.toLowerCase() !== primaryCategory.toLowerCase());

  const rawAreas = Array.isArray(data.serviceAreas) ? data.serviceAreas : [];
  const areaSeen = new Set();
  const areas = [];
  for (const a of rawAreas) {
    const areaName = String(a?.areaName || '').trim();
    if (!areaName || areaSeen.has(areaName.toLowerCase())) continue;
    areaSeen.add(areaName.toLowerCase());
    const isTarget = !!a?.isTarget;
    if (isTarget && complete && !a?.targetStartDate) {
      throw badRequest(`"${areaName}" is a target area and needs a targeting start date.`);
    }
    areas.push({ areaName, isTarget, targetStartDate: isTarget ? (a?.targetStartDate || null) : null });
  }

  if (complete) {
    if (!name) throw badRequest('Profile name is required.');
    if (name.length > 150) throw badRequest('Profile name must be 150 characters or fewer.');
    if (!address) throw badRequest('Profile address is required.');
    if (address.length > 300) throw badRequest('Profile address must be 300 characters or fewer.');
    if (!contactNumber) throw badRequest('Contact number is required.');
    if (!services.length) throw badRequest('At least one service is required.');
    if (!primaryCategory) throw badRequest('Primary category is required.');
    if (!areas.length) throw badRequest('At least one service area is required.');
  } else {
    if (name.length > 150) throw badRequest('Profile name must be 150 characters or fewer.');
    if (address.length > 300) throw badRequest('Profile address must be 300 characters or fewer.');
  }

  const payload = {
    name: name || null,
    address: address || null,
    contactNumber: contactNumber || null,
    gmbProfileUrl: normalizeUrl(data.gmbProfileUrl),
    websiteUrl: normalizeUrl(data.websiteUrl),
    primaryCategory: primaryCategory || null,
    secondaryCategories,
    services,
    status: complete ? 'completed' : 'draft',
    updatedBy: userId || null,
  };

  let profile = await GmbProfile.findOne({ where: { projectId, orgId } });
  if (profile) await profile.update(payload);
  else profile = await GmbProfile.create({ orgId, projectId, ...payload });

  const existing = await GmbServiceArea.findAll({ where: { gmbProfileId: profile.id } });
  const existingByName = new Map(existing.map((row) => [row.areaName.toLowerCase(), row]));
  const keepNames = new Set(areas.map((a) => a.areaName.toLowerCase()));

  for (const row of existing) {
    if (!keepNames.has(row.areaName.toLowerCase())) await row.destroy();
  }
  for (const a of areas) {
    const row = existingByName.get(a.areaName.toLowerCase());
    if (row) await row.update(a);
    else await GmbServiceArea.create({ gmbProfileId: profile.id, ...a });
  }

  return withServiceAreas(profile);
}

/** Distinct services/categories already used across the org's other GMB profiles — an auto-growing suggestion list instead of a managed master table. */
async function getSuggestions(orgId) {
  const profiles = await GmbProfile.findAll({
    where: { orgId },
    attributes: ['services', 'primaryCategory', 'secondaryCategories'],
  });
  const services = new Set();
  const categories = new Set();
  for (const p of profiles) {
    for (const s of p.services || []) services.add(s);
    if (p.primaryCategory) categories.add(p.primaryCategory);
    for (const c of p.secondaryCategories || []) categories.add(c);
  }
  return {
    services: [...services].sort((a, b) => a.localeCompare(b)),
    categories: [...categories].sort((a, b) => a.localeCompare(b)),
  };
}

module.exports = {
  getProfile,
  saveProfile,
  getSuggestions,
};
