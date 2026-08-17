const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const SalarySlip = sequelize.define('SalarySlip', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    payrollItemId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      unique: true,
      references: { model: 'payroll_items', key: 'id' },
    },
    fileUrl: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    generatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    sentAt: {
      type: DataTypes.DATE,
    },
  }, {
    tableName: 'salary_slips',
    timestamps: false,
  });

  SalarySlip.associate = (db) => {
    SalarySlip.belongsTo(db.PayrollItem, { foreignKey: 'payrollItemId', as: 'payrollItem' });
  };

  return SalarySlip;
};
