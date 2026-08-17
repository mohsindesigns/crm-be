const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

// A worker's performance review / salary revision history. `rating` is a free-text
// label (e.g. "Exceeds Expectations") rather than a fixed enum, matching this
// codebase's low-ceremony style for admin-entered qualitative fields — validating a
// tight enum here would just force the admin UI to hardcode a rating scale that's a
// business decision, not a schema one.
module.exports = (sequelize, DataTypes) => {
  const Appraisal = sequelize.define('Appraisal', {
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
    workerId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workers', key: 'id' },
    },
    reviewDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    rating: {
      type: DataTypes.STRING(50),
    },
    notes: {
      type: DataTypes.TEXT,
    },
    salaryBefore: {
      type: DataTypes.DECIMAL(12, 2),
    },
    salaryAfter: {
      type: DataTypes.DECIMAL(12, 2),
    },
    approvedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'appraisals',
    updatedAt: false,
    indexes: [{ fields: ['worker_id'] }, { fields: ['org_id'] }],
  });

  Appraisal.associate = (db) => {
    Appraisal.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
    Appraisal.belongsTo(db.User, { foreignKey: 'approvedBy', as: 'approver' });
  };

  Appraisal.ensureSchema = () => ensureColumns(Appraisal);

  return Appraisal;
};
