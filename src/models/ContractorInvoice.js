const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const ContractorInvoice = sequelize.define('ContractorInvoice', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    workerId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workers', key: 'id' },
    },
    period: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'PKR',
    },
    description: {
      type: DataTypes.TEXT,
    },
    fileUrl: {
      type: DataTypes.STRING(500),
    },
    status: {
      type: DataTypes.ENUM('submitted', 'approved', 'rejected', 'paid'),
      defaultValue: 'submitted',
    },
    approvedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    paidAt: {
      type: DataTypes.DATE,
    },
    note: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'contractor_invoices',
    indexes: [
      { fields: ['worker_id', 'period'] },
    ],
  });

  ContractorInvoice.associate = (db) => {
    ContractorInvoice.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
    ContractorInvoice.belongsTo(db.User, { foreignKey: 'approvedBy', as: 'approver' });
  };

  return ContractorInvoice;
};
