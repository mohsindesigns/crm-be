const { createPdfBuffer, fetchImageBuffer } = require('./PdfService');
const { letterheadForOrg, loadLetterheadLogo, LETTERHEAD_DEFAULTS } = require('./letterhead');
const { PDFDocument } = require('pdf-lib');
const db = require('../models');

const DOCUMENT_TITLES = {
  appointment_letter: 'Letter of Appointment',
  confirmation_letter: 'Letter of Employment Confirmation',
  bank_opening_letter: 'Bank Account Opening Letter',
  experience_letter: 'Experience Certificate',
  salary_certificate: 'Salary Certificate',
};

/** Layout tuned to the Documents template folder samples (no decorative borders). */
const PAGE = {
  marginTop: 44,
  marginSide: 64,
  marginBottom: 60,
  logoH: 42,
  /** Extra space below logo before date/title. */
  afterLogo: 28,
  /** Space below date before title / body. */
  afterDate: 32,
  footerBand: 48,
  bodySize: 12,
  titleSize: 16,
  /** Extra leading between wrapped lines inside a paragraph. */
  lineGap: 8,
  /** Space after a full body paragraph (blank-line feel). */
  paraAfter: 16,
  /** Space above / below centered titles (e.g. TO WHOM IT MAY CONCERN). */
  titleBefore: 10,
  titleAfter: 22,
  /** Tight rows for address / To / CNIC blocks. */
  lineAfter: 4,
};

function fmt(date) {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function amountInWords(num) {
  const n = Number(num || 0);
  if (!Number.isFinite(n) || n <= 0) return 'Zero';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const toWords = (x) => {
    if (x < 10) return ones[x];
    if (x < 20) return teens[x - 10];
    if (x < 100) return `${tens[Math.floor(x / 10)]}${x % 10 ? `-${ones[x % 10]}` : ''}`;
    if (x < 1000) return `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? ` ${toWords(x % 100)}` : ''}`;
    if (x < 100000) return `${toWords(Math.floor(x / 1000))} Thousand${x % 1000 ? ` ${toWords(x % 1000)}` : ''}`;
    if (x < 10000000) return `${toWords(Math.floor(x / 100000))} Lakh${x % 100000 ? ` ${toWords(x % 100000)}` : ''}`;
    return `${toWords(Math.floor(x / 10000000))} Crore${x % 10000000 ? ` ${toWords(x % 10000000)}` : ''}`;
  };
  return toWords(Math.round(n));
}

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Employee';
  return n.split(/\s+/)[0];
}

function honorificName(name) {
  const n = String(name || '').trim();
  if (!n) return 'the employee';
  if (/^(mr|ms|mrs|miss)\b/i.test(n)) return n;
  return `Mr./Ms. ${n}`;
}

function salaryPhrase(currency, amount) {
  const cur = String(currency || 'PKR').toUpperCase();
  const n = Number(amount || 0).toLocaleString('en-PK');
  const words = amountInWords(amount);
  if (cur === 'PKR' || cur === 'RS' || cur === 'RS.') {
    return `Rs. ${n}/- (Rupees ${words} Only)`;
  }
  return `${cur} ${n} (${words} Only)`;
}

function probationLabel(w) {
  if (w.joiningDate && w.probationEndDate) {
    const a = new Date(w.joiningDate);
    const b = new Date(w.probationEndDate);
    const months = Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24 * 30.44)));
    return `${months} Month${months === 1 ? '' : 's'}`;
  }
  return '3 Months';
}

function p(text) { return { type: 'p', text: String(text) }; }
/** Single address / label row — tighter than body paragraphs. */
function line(text, opts = {}) {
  return { type: 'line', text: String(text), bold: !!opts.bold, underline: !!opts.underline };
}
function heading(text) { return { type: 'h', text: String(text) }; }
function spacer(pt = 8) { return { type: 'spacer', pt }; }
function signature(companyName) {
  return { type: 'sig', label: `Authorized Signatory\nFor ${companyName}` };
}
/** Inline text run: { text, bold?, underline? } */
function t(text, opts = {}) {
  return { text: String(text), bold: !!opts.bold, underline: !!opts.underline };
}
/** Paragraph built from mixed plain / bold / underline runs (matches Word samples). */
function rich(...parts) {
  return {
    type: 'rich',
    parts: parts.flat().map((part) => (typeof part === 'string' ? { text: part } : part)),
  };
}
/** Same as rich, but address-row spacing (no large paragraph gap). */
function richLine(...parts) {
  return { ...rich(...parts), tight: true };
}

/** Appointment Letter — matches Documents template/Appointment Letter.pdf */
function appointmentLetter(w, user, companyName) {
  const name = user.name || 'Employee';
  const job = w.designation || 'Team Member';
  const salary = salaryPhrase(w.currency, w.salaryBase);
  const join = fmt(w.joiningDate);
  const probation = probationLabel(w);
  const blocks = [
    line('To,', { bold: true }),
    line(honorificName(name), { bold: true }),
  ];
  if (w.cnic) {
    blocks.push(richLine('CNIC No: ', t(w.cnic, { bold: true })));
  }
  if (w.address) {
    blocks.push(richLine('Address: ', t(oneLine(w.address), { bold: true })));
  }
  blocks.push(
    spacer(16),
    line('Subject: Letter of Appointment', { bold: true, underline: true }),
    spacer(14),
    p(`Dear ${firstName(name)},`),
    rich(
      'With reference to your application and subsequent interview, the management of ',
      t(companyName, { bold: true }),
      ' is pleased to appoint you as a permanent full-time ',
      t(job, { bold: true }),
      ' on the following terms and conditions:',
    ),
    heading('1. Date of Joining & Reporting'),
    rich(
      'Your appointment is effective from ',
      t(join, { bold: true }),
      '. You will report directly to your assigned reporting manager / department head.',
    ),
    heading('2. Compensation & Benefits'),
    rich(
      'Your gross monthly salary will be ',
      t(salary, { bold: true }),
      ', subject to applicable tax deductions as per local regulations. Salary will be credited on a monthly basis.',
    ),
    heading('3. Probation Period'),
    // The duration alone leaves the employee to work out when it actually ends.
    // The profile already records the exact date, so state it — omitted only
    // when the profile has none.
    rich(
      'You will be on a probation period of ',
      t(probation, { bold: true }),
      ' from the date of your joining',
      ...(w.probationEndDate
        ? [', ending on ', t(fmt(w.probationEndDate), { bold: true })]
        : []),
      '. Upon successful completion of this period, your employment will be confirmed in writing. The management reserves the right to extend the probation period or terminate employment during this timeframe if performance is unsatisfactory.',
    ),
    heading('4. Core Responsibilities'),
    p(`Your duties will include, but are not limited to, the tasks associated with your designation${w.department ? ` in the ${w.department} department` : ''}, as well as any other professional assignments delegated to you by the management to support agency workflows.`),
    heading('5. Confidentiality & Non-Disclosure'),
    p(`During and after your employment with the company, you shall not disclose, share, or misuse any confidential information, client data, source codes, project credentials, or proprietary business processes belonging to ${companyName}.`),
    heading('6. Termination & Resignation'),
    rich(
      '• ',
      t('During Probation: ', { bold: true }),
      "Either party can terminate this contract by giving ",
      t("15 days'", { bold: true }),
      ' notice or salary in lieu thereof.',
    ),
    rich(
      '• ',
      t('After Confirmation: ', { bold: true }),
      'Either party can terminate this employment by giving ',
      t('1 month', { bold: true }),
      ' written notice or salary in lieu thereof.',
    ),
    p('Please review the terms above. If you accept this offer, please sign and return the duplicate copy of this letter as a token of your acceptance.'),
    p('We welcome you to our team and wish you a successful career with us.'),
    spacer(28),
    signature(companyName),
    spacer(18),
    heading('Employee Acceptance'),
    p('I have read, understood, and accept the terms and conditions of employment mentioned above.'),
    spacer(22),
    line('Signature: ______________________', { bold: true }),
    spacer(10),
    line('Date: ______________________', { bold: true }),
  );
  return blocks;
}

/** Confirmation Letter — matches Documents template/confirmation letter.pdf */
function confirmationLetter(w, user, companyName) {
  const name = user.name || 'Employee';
  const job = w.designation || 'Team Member';
  const salary = salaryPhrase(w.currency, w.salaryBase);
  const confDate = fmt(w.confirmationDate || w.probationEndDate);
  const blocks = [
    line('To,', { bold: true }),
    line(honorificName(name), { bold: true }),
  ];
  if (w.cnic) blocks.push(richLine('CNIC No: ', t(w.cnic, { bold: true })));
  blocks.push(richLine('Designation: ', t(job, { bold: true })));
  blocks.push(
    spacer(16),
    line('Subject: Letter of Employment Confirmation', { bold: true, underline: true }),
    spacer(14),
    p(`Dear ${firstName(name)},`),
    rich(
      'Consequent to the successful completion of your probation period and evaluation of your performance, the management of ',
      t(companyName, { bold: true }),
      ' is pleased to confirm your appointment as a permanent employee, effective from ',
      t(confDate, { bold: true }),
      '.',
    ),
    rich(
      'Your monthly gross salary will remain ',
      t(salary, { bold: true }),
      ', and all other terms and conditions of your employment will continue to be governed by the original Appointment Letter issued to you.',
    ),
    p('During your probation, your dedication, technical contributions, and alignment with our agency\'s workflows have been highly appreciated. We look forward to your continued commitment and valuable contributions to the team\'s growth.'),
    p('Please sign the duplicate copy of this letter as an acknowledgment of receipt.'),
    p('Congratulations on your confirmation! We wish you a long and rewarding career with us.'),
    spacer(28),
    signature(companyName),
    spacer(18),
    heading('Employee Acknowledgment'),
    p('I thank the management for the confirmation of my services and accept the letter.'),
    spacer(22),
    line('Signature: ______________________', { bold: true }),
    spacer(10),
    line('Date: ______________________', { bold: true }),
  );
  return blocks;
}

/** Bank account opening — matches Documents template/bank account opening.pdf */
function bankOpeningLetter(w, user, companyName) {
  const name = user.name || 'Employee';
  const job = w.designation || 'Team Member';
  const salary = salaryPhrase(w.currency, w.salaryBase);
  const introParts = [
    'This is to introduce ',
    t(honorificName(name), { bold: true }),
  ];
  if (w.cnic) {
    introParts.push(', holding CNIC No. ', t(w.cnic, { bold: true }));
  }
  introParts.push(
    ', who is employed with ',
    t(companyName, { bold: true }),
    ' as a permanent full-time ',
    t(job, { bold: true }),
    '.',
  );
  return [
    line('The Branch Manager,', { bold: true }),
    line(`${w.bankName || '[Bank Name]'},`, { bold: true }),
    line((() => {
      const branch = oneLine(w.bankBranchName);
      const city = oneLine(w.bankBranchCity);
      if (branch && city) return `${branch} / ${city}.`;
      if (branch) return `${branch}.`;
      if (city) return `${city}.`;
      return '[Branch Name / City].';
    })(), { bold: true }),
    spacer(16),
    line(`Subject: Request to Open a Salary Account for ${honorificName(name)}`, { bold: true, underline: true }),
    spacer(14),
    p('Dear Sir/Madam,'),
    rich(...introParts),
    p(`${honorificName(name)} wishes to open a salary bank account with your esteemed bank. We request you to kindly facilitate the account opening process for him/her. The company will be crediting his/her monthly salary into this bank account moving forward.`),
    rich('For your reference, his/her current monthly net salary is ', t(salary, { bold: true }), '.'),
    p('Your cooperation in this regard will be highly appreciated.'),
    spacer(36),
    signature(companyName),
  ];
}

/** Experience certificate — matches Documents template/experience certificate.pdf */
function experienceLetter(w, user, companyName) {
  const name = user.name || 'Employee';
  const job = w.designation || 'Team Member';
  const start = fmt(w.joiningDate);
  const end = w.status === 'inactive' ? fmt(new Date()) : 'Present';
  const parts = [
    'This is to certify that ',
    t(honorificName(name), { bold: true, underline: true }),
  ];
  if (w.cnic) {
    parts.push(' holding CNIC number ', t(w.cnic, { bold: true, underline: true }));
  }
  parts.push(
    ' was employed with ',
    t(companyName, { bold: true }),
    ' as a ',
    t(job, { bold: true }),
    ' from ',
    t(start, { bold: true }),
    ' to ',
    t(end, { bold: true }),
    '.',
  );
  return [
    { type: 'title', text: 'TO WHOM IT MAY CONCERN' },
    rich(...parts),
    p('During his/her tenure with us, he/she demonstrated strong dedication, professionalism, and a solid work ethic. He/She successfully handled his/her assigned responsibilities and proved to be a valuable asset to our team.'),
    p('We appreciate his/her contributions to the company and wish him/her every success in his/her future professional endeavors.'),
    spacer(40),
    signature(companyName),
  ];
}

/** Salary certificate — matches Documents template/salary letter updated.pdf */
function salaryCertificate(w, user, companyName) {
  const name = user.name || 'Employee';
  const job = w.designation || 'Team Member';
  const salary = salaryPhrase(w.currency, w.salaryBase);
  const parts = [
    'This is to certify that ',
    t(honorificName(name), { bold: true, underline: true }),
  ];
  if (w.cnic) {
    parts.push(' holding CNIC number ', t(w.cnic, { bold: true, underline: true }));
  }
  parts.push(
    ' has been employed with ',
    t(companyName, { bold: true }),
    ' as a ',
    job,
    ' as a permanent full-time employee.',
  );
  return [
    { type: 'title', text: 'TO WHOM IT MAY CONCERN' },
    rich(...parts),
    rich('His/Her current monthly gross salary is ', t(salary, { bold: true }), '.'),
    p('This certificate is being issued at the employee\'s request and carries no financial liability on part of the company.'),
    spacer(40),
    signature(companyName),
  ];
}

const GENERATORS = {
  appointment_letter: appointmentLetter,
  confirmation_letter: confirmationLetter,
  bank_opening_letter: bankOpeningLetter,
  experience_letter: experienceLetter,
  salary_certificate: salaryCertificate,
};

function drawLetterFooter(doc, { address, website, email, phone }, m = PAGE) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const bandTop = doc.page.height - m.footerBand;

  if (typeof doc.switchToPage === 'function') {
    try {
      const range = doc.bufferedPageRange();
      doc.switchToPage(range.start + range.count - 1);
    } catch { /* ignore */ }
  }

  doc.save();
  doc.moveTo(left, bandTop).lineTo(right, bandTop).lineWidth(0.7).strokeColor('#333333').stroke();
  let y = bandTop + 8;
  const addr = oneLine(address);
  if (addr) {
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text(addr, left, y, { width, align: 'center', lineBreak: false, height: 10 });
    y += 11;
  }
  const contact = [oneLine(website), oneLine(email), oneLine(phone)].filter(Boolean).join('      ');
  if (contact) {
    doc.font('Helvetica').fontSize(8).fillColor('#555555')
      .text(contact, left, y, { width, align: 'center', lineBreak: false, height: 10 });
  }
  doc.restore();
}

function drawCenteredLogo(doc, logo, { left, top, contentWidth, height }) {
  if (!logo?.buffer) return top;
  try {
    const img = doc.openImage(logo.buffer);
    const h = height;
    const w = Math.min(contentWidth, (img.width / img.height) * h);
    const x = left + (contentWidth - w) / 2;
    doc.image(img, x, top, { width: w, height: h });
    return top + h;
  } catch {
    try {
      doc.image(logo.buffer, left, top, { fit: [contentWidth, height], align: 'center' });
      return top + height;
    } catch {
      return top;
    }
  }
}

function ensurePageSpace(doc, needed, m = PAGE) {
  const bottom = doc.page.height - m.footerBand - 12;
  // These `needed` figures are written for the default type size. While a letter
  // is being compressed to fit one page they have to shrink with it, or a block
  // reserves far more room than it will occupy and triggers a page break that
  // was never necessary — which is what kept the appointment letter on two pages
  // even at the tightest setting.
  const required = needed * (m.spacerScale ?? 1);
  if (doc.y + required > bottom) {
    doc.addPage();
    doc.y = doc.page.margins.top;
    doc.x = doc.page.margins.left;
  }
}

/**
 * Signature / stamp block.
 *
 * Its geometry is derived from the size its CONTENT is actually drawn at, and
 * `doc.y` is advanced past the tallest of them. It must not be scaled the way
 * plain whitespace is: the signature image, the stamp and the two label lines
 * have real heights, so shrinking the reserved space without shrinking them
 * stacked the label, the stamp and the block that follows on top of each other.
 *
 * Compression is allowed, but only down to a floor where everything still
 * clears — and every offset below is computed from the same scaled sizes rather
 * than from constants.
 */
function drawSignatureBlock(doc, block, opts = {}, m = PAGE) {
  const left = doc.page.margins.left;
  // Never below ~0.62: past that the signature is unreadable and the stamp
  // starts colliding with the label no matter how the offsets are computed.
  const scale = Math.max(0.62, m.spacerScale ?? 1);

  const sigW = 160 * scale;
  const sigH = 44 * scale;
  const stampSize = 68 * scale;
  const labelSize = Math.max(8, 10 * scale);
  const labelLeading = labelSize + 4;
  const gapAboveRule = 4 * scale;
  const gapBelowRule = Math.max(6, 10 * scale);

  const labelLines = String(block.label || '').split('\n').filter(Boolean);
  // Everything this block will occupy, measured before reserving it.
  const blockH = sigH + gapAboveRule + gapBelowRule + (labelLines.length * labelLeading) + 6;
  const needed = Math.max(blockH, stampSize + 10);

  ensurePageSpace(doc, needed / (m.spacerScale ?? 1), m); // undo the caller's scaling — this figure is already exact
  const signTop = doc.y;

  if (opts.signatureBuffer) {
    try {
      doc.image(opts.signatureBuffer, left, signTop, { fit: [sigW, sigH], align: 'left' });
    } catch { /* ignore */ }
  }

  const lineY = signTop + sigH + gapAboveRule;
  const lineEnd = left + Math.max(sigW, 180 * scale);
  doc.moveTo(left, lineY).lineTo(lineEnd, lineY).strokeColor('#222222').lineWidth(0.9).stroke();

  if (opts.stampBuffer) {
    try {
      // Sits to the right of the rule, never over the label beneath it.
      doc.image(opts.stampBuffer, lineEnd + 16, signTop, {
        fit: [stampSize, stampSize],
        align: 'left',
      });
    } catch { /* ignore */ }
  }

  doc.font('Helvetica').fontSize(labelSize).fillColor('#333333');
  labelLines.forEach((line, i) => {
    doc.text(line, left, lineY + gapBelowRule + (i * labelLeading), { width: sigW + 60, lineBreak: false });
  });

  const labelBottom = lineY + gapBelowRule + (labelLines.length * labelLeading);
  const stampBottom = signTop + (opts.stampBuffer ? stampSize : 0);
  doc.y = Math.max(labelBottom, stampBottom) + 6;
  doc.x = left;
}

function drawRichBlock(doc, block, left, usableWidth, m = PAGE) {
  const parts = (block.parts || []).filter((p) => p && String(p.text || '').length);
  if (!parts.length) return;
  ensurePageSpace(doc, block.tight ? 24 : 56, m);
  const startY = doc.y;
  const lineGap = block.tight ? 2 : m.lineGap;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const last = i === parts.length - 1;
    doc.font(part.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(m.bodySize)
      .fillColor('#222222');
    const opts = {
      width: usableWidth,
      align: 'left',
      lineGap,
      continued: !last,
      underline: !!part.underline,
    };
    if (i === 0) doc.text(String(part.text), left, startY, opts);
    else doc.text(String(part.text), opts);
  }
  doc.x = left;
  doc.y += block.tight ? m.lineAfter : m.paraAfter;
}

function renderBlocks(doc, blocks, opts = {}, m = PAGE) {
  const left = doc.page.margins.left;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bodyOpts = {
    width: usableWidth,
    align: 'left',
    lineGap: m.lineGap,
    characterSpacing: 0,
  };

  for (const block of blocks) {
    if (block.type === 'spacer') {
      doc.y += (block.pt || 8) * (m.spacerScale ?? 1);
      continue;
    }
    if (block.type === 'title') {
      ensurePageSpace(doc, 48, m);
      doc.y += m.titleBefore;
      const ty = doc.y;
      doc.font('Helvetica-Bold').fontSize(m.titleSize).fillColor('#111111');
      const tw = doc.widthOfString(block.text);
      const tx = left + (usableWidth - tw) / 2;
      doc.text(block.text, left, ty, { width: usableWidth, align: 'center', lineBreak: false });
      // Match sample: underlined centered title
      const underlineY = ty + m.titleSize + 3;
      doc.moveTo(tx, underlineY).lineTo(tx + tw, underlineY)
        .strokeColor('#111111').lineWidth(1.1).stroke();
      doc.y = underlineY + m.titleAfter;
      doc.x = left;
      continue;
    }
    if (block.type === 'h') {
      ensurePageSpace(doc, 28, m);
      doc.y += 10;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
        .text(block.text, left, doc.y, { width: usableWidth, align: 'left', lineGap: 3 });
      doc.x = left;
      doc.y += 8;
      continue;
    }
    if (block.type === 'line') {
      ensurePageSpace(doc, 22, m);
      const before = doc.y;
      doc.font(block.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(m.bodySize)
        .fillColor('#222222')
        .text(block.text, left, doc.y, {
          width: usableWidth,
          align: 'left',
          lineGap: 2,
          characterSpacing: 0,
          underline: !!block.underline,
        });
      if (doc.y <= before + 1) doc.y = before + m.bodySize + 2;
      doc.y += m.lineAfter;
      doc.x = left;
      continue;
    }
    if (block.type === 'rich') {
      drawRichBlock(doc, block, left, usableWidth, m);
      continue;
    }
    if (block.type === 'p') {
      ensurePageSpace(doc, 52, m);
      doc.font('Helvetica').fontSize(m.bodySize).fillColor('#222222')
        .text(block.text, left, doc.y, bodyOpts);
      doc.x = left;
      doc.y += m.paraAfter;
      continue;
    }
    if (block.type === 'sig') {
      drawSignatureBlock(doc, block, opts, m);
    }
  }
}

async function generateDocumentBuffer(workerId, orgId, type) {
  const worker = await db.Worker.findOne({
    where: { id: workerId, orgId },
    include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'email'] }],
  });
  if (!worker) throw Object.assign(new Error('Worker not found.'), { status: 404 });

  const generator = GENERATORS[type];
  if (!generator) throw Object.assign(new Error(`Unsupported document type: ${type}`), { status: 400 });

  const title = DOCUMENT_TITLES[type] || type;
  const [hrCompany, letterhead] = await Promise.all([
    db.Company.primaryFor(orgId, 'hr').catch(() => null),
    letterheadForOrg(orgId, 'hr'),
  ]);
  const companyDetails = hrCompany?.toJSON ? hrCompany.toJSON() : (hrCompany || {});
  const company = letterhead?.entities?.[0] || {};
  const companyName = companyDetails.legalName || company.legalName || LETTERHEAD_DEFAULTS.legalName;
  const blocks = generator(worker, worker.user, companyName);

  const [logo, signatureBuffer, stampBuffer] = await Promise.all([
    loadLetterheadLogo(companyDetails.logoUrl || company.logoUrl || letterhead.logoUrl),
    companyDetails.signatureUrl ? fetchImageBuffer(companyDetails.signatureUrl) : null,
    companyDetails.stampUrl ? fetchImageBuffer(companyDetails.stampUrl) : null,
  ]);

  /**
   * Footer contact details.
   *
   * When a company row exists, IT is the authority — including its blanks. An
   * admin who clears the phone on the HR company means "don't print a phone",
   * and the old `|| LETTERHEAD_DEFAULTS.businessPhone` tail overrode that with a
   * hardcoded number, so the field could never actually be removed. Same for
   * email and address.
   *
   * The built-in defaults still apply, but only for an org with no company
   * configured at all — a fresh install, where they're better than a blank
   * footer.
   */
  const hasCompany = !!companyDetails.id || !!company.id;
  const pick = (...vals) => {
    for (const v of vals) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  const address = hasCompany
    ? pick(companyDetails.address, company.address)
    : pick(
      letterhead?.entities?.map((e) => e.address).filter(Boolean).join(', '),
      LETTERHEAD_DEFAULTS.pkOfficeAddress,
    );
  const website = hasCompany
    ? pick(companyDetails.website, company.website)
    : pick(letterhead?.website);
  const email = hasCompany
    ? pick(companyDetails.email, company.email)
    : pick(letterhead?.contactEmail, LETTERHEAD_DEFAULTS.contactEmail);
  const phone = hasCompany
    ? pick(companyDetails.phone, company.phone)
    : pick(letterhead?.businessPhone, LETTERHEAD_DEFAULTS.businessPhone);

  const renderAt = (m) => createPdfBuffer((doc) => {
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentWidth = right - left;
    const top = doc.page.margins.top;

    let y = drawCenteredLogo(doc, logo, { left, top, contentWidth, height: m.logoH });
    y = (y > top ? y + m.afterLogo : top + m.afterLogo);

    doc.font('Helvetica-Bold').fontSize(Math.min(11, m.bodySize - 1)).fillColor('#222222')
      .text(`Date: ${fmt(new Date())}`, left, y, {
        width: contentWidth,
        align: 'right',
        lineBreak: false,
      });
    doc.x = left;
    doc.y = y + m.afterDate;

    renderBlocks(doc, blocks, { signatureBuffer, stampBuffer }, m);
    drawLetterFooter(doc, { address, website, email, phone }, m);
  }, {
    margins: {
      top: m.marginTop,
      left: m.marginSide,
      right: m.marginSide,
      bottom: m.marginBottom,
    },
    bufferPages: true,
    info: {
      Title: `${title} — ${worker.user?.name || ''}`.trim().replace(/[—\s]+$/, ''),
      Author: companyName,
    },
  });

  const pageCount = async (buf) => {
    try { return (await PDFDocument.load(buf)).getPageCount(); } catch { return 1; }
  };

  /**
   * Fit to one page by re-rendering tighter, not by hardcoding a smaller layout.
   *
   * The five letters share one set of metrics, and most already fit — squeezing
   * all of them to fix the two that don't would make the short ones look
   * cramped for no reason. So: render at the normal size, and only if the result
   * spills do we retry progressively tighter. A letter that already fits is
   * byte-for-byte unchanged, and a genuinely long one (an unusually long address
   * or job title) still compresses rather than spilling.
   */
  const FIT_STEPS = [
    { bodySize: 11.2, lineGap: 6, paraAfter: 12, afterLogo: 20, afterDate: 22, marginTop: 38, marginBottom: 50, marginSide: 58, titleAfter: 16, logoH: 36, spacerScale: 0.7 },
    { bodySize: 10.4, lineGap: 4.5, paraAfter: 9, afterLogo: 14, afterDate: 16, marginTop: 32, marginBottom: 42, marginSide: 52, titleAfter: 12, logoH: 32, footerBand: 42, spacerScale: 0.5 },
    { bodySize: 9.6, lineGap: 3.5, paraAfter: 7, afterLogo: 10, afterDate: 12, marginTop: 28, marginBottom: 36, marginSide: 46, titleAfter: 10, logoH: 28, footerBand: 38, spacerScale: 0.34 },
    { bodySize: 8.8, lineGap: 2.5, paraAfter: 5, afterLogo: 8, afterDate: 10, marginTop: 24, marginBottom: 30, marginSide: 42, titleAfter: 8, logoH: 24, footerBand: 34, spacerScale: 0.22 },
  ];

  let buffer = await renderAt(PAGE);
  let pages = await pageCount(buffer);

  for (const step of FIT_STEPS) {
    if (pages <= 1) break;
    const candidate = await renderAt({ ...PAGE, ...step });
    const candidatePages = await pageCount(candidate);
    // Keep the tightest attempt even if it still spills — it is closer to
    // fitting than the previous one, and the loop stops as soon as it lands.
    buffer = candidate;
    pages = candidatePages;
  }

  return { buffer, worker, type, title };
}

module.exports = { generateDocumentBuffer, DOCUMENT_TITLES, SUPPORTED_TYPES: Object.keys(GENERATORS) };
