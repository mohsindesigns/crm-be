const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const InvoiceLine = sequelize.define('InvoiceLine', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    invoiceId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'invoices', key: 'id' },
    },
    description: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    qty: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 1,
    },
    unitPrice: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
  }, {
    tableName: 'invoice_lines',
    timestamps: false,
  });

  InvoiceLine.associate = (db) => {
    InvoiceLine.belongsTo(db.Invoice, { foreignKey: 'invoiceId', as: 'invoice' });
  };

  return InvoiceLine;
};
