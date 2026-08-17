const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const HrDepartment = sequelize.define('HrDepartment', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: { type: DataTypes.CHAR(36), allowNull: false },
    name:  { type: DataTypes.STRING(100), allowNull: false },
    // Soft delete — see models/softDeletable.js. A retired department still has to
    // resolve on historical workers/payroll, so it is deactivated, never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'hr_departments',
    underscored: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ['org_id', 'name'] }],
  });

  HrDepartment.ensureSchema = () => ensureColumns(HrDepartment);

  return HrDepartment;
};
