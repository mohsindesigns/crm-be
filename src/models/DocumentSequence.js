const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * Per-series counters behind self-describing document numbers.
 *
 * Numbers read as `<COMPANY>-<TYPE>-<YY>-<NNNN>` — `MDL-INV-26-0001`,
 * `MDP-QT-26-0014` — so you can tell which entity issued it, what kind of
 * document it is, and roughly when, without opening the file.
 *
 * The counter lives in a table rather than being derived from the last invoice
 * because the old approach (`parseInt(number.replace(/\D/g, ''))` over the
 * highest number) cannot survive a prefix: `MDL-INV-26-0001` strips to `2600 01`
 * → 260001, and the next invoice would jump to 260002. A dedicated row per
 * series also makes the allocation lockable, so two invoices raised in the same
 * second can't collide on the unique (org_id, number) index.
 *
 * Legacy `INV-0001` numbers are left exactly as they are. The first number in a
 * new series starts at 1 regardless of what came before, because the series key
 * (company + type + year) is itself new.
 */
module.exports = (sequelize, DataTypes) => {
  const DocumentSequence = sequelize.define('DocumentSequence', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'orgs', key: 'id' },
    },
    // Company.code at the time of allocation, denormalised on purpose: renaming
    // or deleting a company must never renumber documents already issued.
    companyCode: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'CO',
    },
    // INV | QT | AGR | PRO
    docType: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    // Two-digit year the series belongs to; counters restart each January.
    year: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lastSeq: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  }, {
    tableName: 'document_sequences',
    indexes: [
      {
        unique: true,
        fields: ['orgId', 'companyCode', 'docType', 'year'],
        name: 'document_sequences_series_unique',
      },
    ],
  });

  DocumentSequence.ensureSchema = async () => {
    await ensureColumns(DocumentSequence);
    try {
      await DocumentSequence.sequelize.getQueryInterface().addIndex(
        'document_sequences',
        ['orgId', 'companyCode', 'docType', 'year'],
        { unique: true, name: 'document_sequences_series_unique' },
      );
    } catch {
      // Already present.
    }
  };

  /**
   * Allocate the next number in a series and return it formatted.
   *
   * Must be called inside a transaction by anything that also writes the
   * document row, so a failed insert doesn't burn a number. The row lock is what
   * serialises concurrent allocation; the retry covers the one case a lock can't
   * (two callers both finding no row and both inserting).
   *
   * @param {object} opts
   * @param {string} opts.orgId
   * @param {string} opts.companyCode  e.g. 'MDL'
   * @param {string} opts.docType      e.g. 'INV'
   * @param {object} [opts.transaction]
   * @param {number} [opts.pad]        digits in the sequence part (default 4)
   */
  DocumentSequence.next = async ({
    orgId, companyCode, docType, transaction = null, pad = 4,
  }) => {
    const code = String(companyCode || 'CO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'CO';
    const type = String(docType || 'DOC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const year = new Date().getFullYear() % 100;

    const where = { orgId, companyCode: code, docType: type, year };

    let row = await DocumentSequence.findOne({
      where,
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });

    if (!row) {
      try {
        row = await DocumentSequence.create(
          { id: uuidv4(), ...where, lastSeq: 0 },
          { transaction },
        );
      } catch {
        // Lost the race to another caller — re-read theirs and lock it.
        row = await DocumentSequence.findOne({
          where,
          transaction,
          lock: transaction ? transaction.LOCK.UPDATE : undefined,
        });
        if (!row) throw new Error('Could not allocate a document number.');
      }
    }

    const seq = (row.lastSeq || 0) + 1;
    await row.update({ lastSeq: seq }, { transaction });

    return `${code}-${type}-${String(year).padStart(2, '0')}-${String(seq).padStart(pad, '0')}`;
  };

  return DocumentSequence;
};
