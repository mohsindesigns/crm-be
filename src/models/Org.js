const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const Org = sequelize.define('Org', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    subdomain: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    plan: {
      type: DataTypes.STRING(50),
      defaultValue: 'internal',
    },
    status: {
      type: DataTypes.ENUM('active', 'suspended', 'cancelled'),
      defaultValue: 'active',
    },
  }, {
    tableName: 'orgs',
  });

  Org.associate = (db) => {
    Org.hasOne(db.WhiteLabelConfig, { foreignKey: 'orgId', as: 'brand' });
    Org.hasMany(db.User, { foreignKey: 'orgId', as: 'users' });
    Org.hasMany(db.Role, { foreignKey: 'orgId', as: 'roles' });
    Org.hasMany(db.Client, { foreignKey: 'orgId', as: 'clients' });
    Org.hasMany(db.Project, { foreignKey: 'orgId', as: 'projects' });
    Org.hasMany(db.WorkflowTemplate, { foreignKey: 'orgId', as: 'workflowTemplates' });
    Org.hasOne(db.PayrollSettings, { foreignKey: 'orgId', as: 'payrollSettings' });
  };

  return Org;
};
