const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Backlink = sequelize.define('Backlink', {
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
    sourceUrl: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    targetUrl: {
      type: DataTypes.TEXT,
    },
    anchorText: {
      type: DataTypes.STRING(255),
    },
    da: {
      type: DataTypes.INTEGER,
    },
    linkType: {
      type: DataTypes.ENUM('dofollow', 'nofollow', 'other'),
      defaultValue: 'other',
    },
    isIndexed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    indexedCheckedAt: {
      type: DataTypes.DATE,
    },
    addedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Who is on the hook for this link — mirrors Keyword.assignedWriterId. With
    // several people building links on one project (and people leaving mid-
    // campaign), `addedBy` alone only records who typed the row in, not who owns
    // the work; this gives a per-link trail of who wrote/placed it.
    assignedWriterId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Publish date of the backlink itself (from the "Date" column in the client's
    // tracking sheet) — distinct from createdAt, which is when the row was added
    // to Mohsin Designs Project Management.
    date: {
      type: DataTypes.DATEONLY,
    },
    domain: {
      type: DataTypes.STRING(255),
    },
    // Freely editable lifecycle status (e.g. live/pending/removed) — separate from
    // isIndexed, which is specifically "has Google indexed this URL".
    status: {
      type: DataTypes.STRING(50),
      defaultValue: 'live',
    },
    // Spam score ("S.S" column in the client's tracking sheet).
    spamScore: {
      type: DataTypes.INTEGER,
    },
    // Preserves sheet / manual add order within a project (0-based).
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'backlinks',
    indexes: [{ fields: ['project_id'] }, { fields: ['cycle_id'] }],
    updatedAt: true,
  });

  Backlink.associate = (db) => {
    Backlink.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Backlink.belongsTo(db.ProjectCycle, { foreignKey: 'cycleId', as: 'cycle' });
    Backlink.belongsTo(db.User, { foreignKey: 'addedBy', as: 'addedByUser' });
    Backlink.belongsTo(db.User, { foreignKey: 'assignedWriterId', as: 'assignedWriter' });
  };

  // The DB column's ENUM had drifted to ('guest','directory','profile','forum',
  // 'blog_comment','other') — an older link-building-tactic taxonomy — while this
  // model and the "Add Backlink" form have always used ('dofollow','nofollow',
  // 'other'). Selecting Dofollow/Nofollow in the UI crashed with a MySQL "Data
  // truncated for column" error. Widen the column to match what's actually used.
  Backlink.ensureSchema = async () => {
    await ensureColumns(Backlink); // adds date/domain/status/spamScore/updatedAt/sortOrder
    await ensureColumnType(Backlink, 'linkType');
    // Older installs had updatedAt disabled — backfill so "Last updated" isn't blank.
    try {
      await Backlink.sequelize.query(
        'UPDATE `backlinks` SET `updatedAt` = `createdAt` WHERE `updatedAt` IS NULL'
      );
    } catch {
      // Column may not exist yet on a brand-new createTable path; ignore.
    }
    try {
      const nulls = await Backlink.findAll({
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
            const max = await Backlink.max('sortOrder', { where: { projectId } });
            i = Number.isFinite(max) ? max + 1 : 0;
          }
          await row.update({ sortOrder: i });
          i += 1;
        }
      }
    } catch {
      // ignore
    }
  };

  return Backlink;
};
