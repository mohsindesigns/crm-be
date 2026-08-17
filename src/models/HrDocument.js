const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const HrDocument = sequelize.define('HrDocument', {
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
    type: {
      type: DataTypes.ENUM(
        'offer_letter',
        'appointment_letter',
        'confirmation_letter',
        'experience_letter',
        'warning_letter',
        'nda',
        'contract',
        'cnic_copy',
        'cv',
        'cnic_front',
        'cnic_back',
        'salary_certificate',
        'bank_opening_letter',
        'other'
      ),
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING(255),
    },
    // Empty while status is "requested" — filled when HR issues the letter.
    fileUrl: {
      type: DataTypes.STRING(500),
      allowNull: false,
      defaultValue: '',
    },
    fileName: {
      type: DataTypes.STRING(255),
    },
    uploadedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // requested = employee asked HR to issue; issued = file ready; rejected = declined.
    status: {
      type: DataTypes.ENUM('requested', 'issued', 'rejected'),
      defaultValue: 'issued',
      allowNull: false,
    },
    rejectionReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATEONLY,
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'hr_documents',
    updatedAt: false,
    indexes: [
      { fields: ['worker_id'] },
      { fields: ['org_id', 'status'] },
    ],
  });

  HrDocument.associate = (db) => {
    HrDocument.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
    HrDocument.belongsTo(db.User, { foreignKey: 'uploadedBy', as: 'uploader' });
  };

  // Widens the `type` ENUM and adds `status` / `rejectionReason` for employee document requests.
  HrDocument.ensureSchema = async () => {
    await ensureColumns(HrDocument);
    await ensureColumnType(HrDocument, 'type');
    await ensureColumnType(HrDocument, 'status');
  };

  return HrDocument;
};
