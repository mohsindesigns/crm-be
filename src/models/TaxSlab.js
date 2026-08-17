const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

// FBR-style bracket row: tax = fixedAmount + ratePercent% × (yearlyIncome − minAmount)
// when yearly income falls in [minAmount, maxAmount] (maxAmount null = open-ended).
module.exports = (sequelize, DataTypes) => {
  const TaxSlab = sequelize.define('TaxSlab', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    taxYearId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'tax_years', key: 'id' },
    },
    minAmount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0,
    },
    maxAmount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
    ratePercent: {
      type: DataTypes.DECIMAL(6, 3),
      allowNull: false,
      defaultValue: 0,
    },
    fixedAmount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'tax_slabs',
    indexes: [{ fields: ['tax_year_id'] }],
  });

  TaxSlab.associate = (db) => {
    TaxSlab.belongsTo(db.TaxYear, { foreignKey: 'taxYearId', as: 'taxYear' });
  };

  TaxSlab.ensureSchema = () => ensureColumns(TaxSlab);

  return TaxSlab;
};
