const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const RankSnapshot = sequelize.define('RankSnapshot', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    projectId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'projects', key: 'id' },
    },
    keywordId: {
      type: DataTypes.CHAR(36),
      references: { model: 'keywords', key: 'id' },
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    position: {
      type: DataTypes.INTEGER,
    },
    url: {
      type: DataTypes.TEXT,
    },
    searchEngine: {
      type: DataTypes.STRING(50),
      defaultValue: 'google',
    },
  }, {
    tableName: 'rank_snapshots',
    timestamps: false,
    indexes: [{ fields: ['project_id', 'date'] }],
  });

  RankSnapshot.associate = (db) => {
    RankSnapshot.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    RankSnapshot.belongsTo(db.Keyword, { foreignKey: 'keywordId', as: 'keyword' });
  };

  return RankSnapshot;
};
