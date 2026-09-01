const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

// One tax year per org can be active — payroll uses that year's slabs for
// Pakistan-style monthly withholding (annualize → tax → ÷ 12).
module.exports = (sequelize, DataTypes) => {
  const TaxYear = sequelize.define('TaxYear', {
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
    label: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    endDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    // Exactly one per org — "the year payroll currently withholds against".
    // This is NOT the soft-delete flag (see isArchived below); most years are
    // legitimately isActive:false while still being live historical records.
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Soft delete — see models/softDeletable.js. Archived years drop out of the
    // HR settings list but stay resolvable for any payroll run that used them.
    isArchived: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Set by duplicateTaxYear — tracks which year a copy was cloned from, purely
    // for provenance display (e.g. "duplicated from 2024-25"). Never enforced.
    sourceTaxYearId: {
      type: DataTypes.CHAR(36),
      allowNull: true,
    },
  }, {
    tableName: 'tax_years',
    indexes: [{ fields: ['org_id'] }, { fields: ['org_id', 'is_active'] }],
  });

  TaxYear.associate = (db) => {
    TaxYear.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    TaxYear.hasMany(db.TaxSlab, { foreignKey: 'taxYearId', as: 'slabs' });
    TaxYear.belongsTo(db.TaxYear, { foreignKey: 'sourceTaxYearId', as: 'sourceTaxYear' });
  };

  TaxYear.ensureSchema = () => ensureColumns(TaxYear);

  return TaxYear;
};
