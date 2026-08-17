const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Keyword = sequelize.define('Keyword', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    projectId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'projects', key: 'id' },
    },
    cycleId: {
      type: DataTypes.CHAR(36),
      references: { model: 'project_cycles', key: 'id' },
    },
    primaryKeyword: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    secondaryKeywords: {
      type: DataTypes.TEXT,
    },
    kd: {
      type: DataTypes.INTEGER,
    },
    volume: {
      type: DataTypes.INTEGER,
    },
    targetUrl: {
      type: DataTypes.TEXT,
    },
    targetLocation: {
      type: DataTypes.STRING(255),
    },
    pageName: {
      type: DataTypes.STRING(255),
    },
    // Focus flag — inactive keywords stay on the sheet for history but drop out of
    // the content pool (remaining/used stats, content picker, stage auto-advance).
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      allowNull: false,
      defaultValue: 'active',
    },
    // Which content writer is on the hook for this keyword's page — assigning it
    // spins up a content-writing Task for them (see SeoService.updateKeyword), and
    // gives a page-by-page trail of who's writing (or wrote) each page's content.
    assignedWriterId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Preserves sheet / manual add order within a project (0-based).
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    batchId: {
      type: DataTypes.CHAR(36),
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'keywords',
    indexes: [{ fields: ['project_id'] }, { fields: ['cycle_id'] }],
  });

  Keyword.ensureSchema = async () => {
    await ensureColumns(Keyword);
    // One-time: give existing rows a stable order matching createdAt ASC.
    try {
      const nulls = await Keyword.findAll({
        where: { sortOrder: null },
        attributes: ['id', 'projectId', 'createdAt'],
        order: [['projectId', 'ASC'], ['createdAt', 'ASC']],
      });
      if (nulls.length) {
        let projectId = null;
        let i = 0;
        for (const row of nulls) {
          if (row.projectId !== projectId) {
            projectId = row.projectId;
            const max = await Keyword.max('sortOrder', { where: { projectId } });
            i = Number.isFinite(max) ? max + 1 : 0;
          }
          await row.update({ sortOrder: i });
          i += 1;
        }
      }
    } catch {
      // ignore on fresh installs
    }
  };

  Keyword.associate = (db) => {
    Keyword.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Keyword.belongsTo(db.ProjectCycle, { foreignKey: 'cycleId', as: 'cycle' });
    Keyword.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    Keyword.belongsTo(db.User, { foreignKey: 'assignedWriterId', as: 'assignedWriter' });
    Keyword.hasMany(db.RankSnapshot, { foreignKey: 'keywordId', as: 'rankings' });
  };

  return Keyword;
};
