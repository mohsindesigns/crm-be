const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

// One requirements email sent from a project to a client contact, plus the
// reply that comes back. Deliberately a single row rather than a request table
// + a response table: a request is answered exactly once (the public link is
// spent on submit), so keeping the answers next to the status keeps
// "has the client replied yet?" a single non-joined read — which is all the
// project tab ever asks.
//
// `fields` is a SNAPSHOT taken from the RequirementFormTemplate at send time,
// never a live reference (see RequirementFormTemplate's header).
module.exports = (sequelize, DataTypes) => {
  const ClientRequest = sequelize.define('ClientRequest', {
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
    projectId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'projects', key: 'id' },
    },
    // Denormalized from the project at send time so a request survives (and
    // still reports correctly) even if the project is later moved.
    clientId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'clients', key: 'id' },
    },
    // Null when the form was composed from scratch instead of a saved template,
    // or when the template it came from has since been deactivated.
    templateId: {
      type: DataTypes.CHAR(36),
      references: { model: 'requirement_form_templates', key: 'id' },
    },
    // The contact this was addressed to. recipientEmail is stored separately
    // (not read through the association) so the audit trail shows the address
    // actually mailed, even if the contact's email changes afterwards.
    contactId: {
      type: DataTypes.CHAR(36),
      references: { model: 'contacts', key: 'id' },
    },
    recipientEmail: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    recipientName: {
      type: DataTypes.STRING(255),
    },
    // Optional extra addresses that were CC'd on the email, as a JSON array of
    // strings. Not modelled as contacts — these may be anyone the sender typed.
    ccEmails: {
      type: DataTypes.JSON,
    },
    // The composed email, exactly as sent.
    subject: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
    },
    fields: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    // Appearance snapshot, same shape/fallback rule as
    // RequirementFormTemplate.theme — copied at send time so a later template
    // edit never changes a link already sitting in a client's inbox.
    theme: {
      type: DataTypes.JSON,
    },
    successMessage: {
      type: DataTypes.TEXT,
    },
    // The only credential the public form page needs — same role as
    // LeadForm.publicToken and CustomerDocument.publicToken, so it must be
    // unguessable (24 random bytes, base64url).
    publicToken: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    // pending_approval — composed by non-admin staff, waiting on an admin.
    //                    Nothing has been emailed and the public link does NOT
    //                    resolve yet (see ClientRequestService#loadByToken).
    // rejected  — an admin turned it down; rejectionReason says why. Terminal:
    //             the composer starts a new request rather than editing this one.
    // sent      — emailed, waiting on the client
    // responded — the client submitted the form (responseData is set)
    // cancelled — staff withdrew it; the public link stops working
    //
    // Only `sent` and `responded` are states in which the emailed link works.
    status: {
      type: DataTypes.ENUM('pending_approval', 'rejected', 'sent', 'responded', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending_approval',
    },
    // When the client is asked to reply by. Drives the reminder scheduler's
    // "overdue" wording; null means no deadline was set.
    dueAt: {
      type: DataTypes.DATEONLY,
    },
    // Who composed it. Named `sentBy` from before the approval gate existed —
    // with the gate, this is the *author*, and approvedBy is who released it.
    sentBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // When the email actually went out — null for the whole time a request sits
    // in pending_approval, so "submitted 3 days ago, still not approved" and
    // "emailed 3 days ago, no reply" stay tellable apart.
    sentAt: {
      type: DataTypes.DATE,
    },
    // Approval trail. An admin composing their own request is auto-approved at
    // send time (approvedBy === sentBy), so a single-admin org never deadlocks.
    approvedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    approvedAt: {
      type: DataTypes.DATE,
    },
    // Set on reject only, and always non-empty there — the composer needs to
    // know what to change before writing the next one.
    rejectionReason: {
      type: DataTypes.TEXT,
    },
    // Set the first time the client opens the public link — lets staff tell
    // "never opened it" apart from "opened it and hasn't replied".
    viewedAt: {
      type: DataTypes.DATE,
    },
    // The reply. Keyed by field `key`, validated against `fields` on submit
    // (see utils/formFields#validateAnswers).
    responseData: {
      type: DataTypes.JSON,
    },
    respondedAt: {
      type: DataTypes.DATE,
    },
    responseIp: {
      type: DataTypes.STRING(64),
    },
    remindersSent: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastReminderAt: {
      type: DataTypes.DATE,
    },
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'client_requests',
    indexes: [
      { fields: ['org_id'] },
      { fields: ['project_id'] },
      { fields: ['status'] },
      { unique: true, fields: ['public_token'] },
    ],
  });

  ClientRequest.associate = (db) => {
    ClientRequest.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    ClientRequest.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    ClientRequest.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    ClientRequest.belongsTo(db.Contact, { foreignKey: 'contactId', as: 'contact' });
    ClientRequest.belongsTo(db.RequirementFormTemplate, { foreignKey: 'templateId', as: 'template' });
    ClientRequest.belongsTo(db.User, { foreignKey: 'sentBy', as: 'sender' });
    ClientRequest.belongsTo(db.User, { foreignKey: 'approvedBy', as: 'approver' });
  };

  ClientRequest.ensureSchema = async () => {
    await ensureColumns(ClientRequest);
    // Widen the status ENUM with `pending_approval`/`rejected` (admin approval
    // gate) — ensureColumns only adds missing columns, never retypes one.
    await ensureColumnType(ClientRequest, 'status');
  };

  return ClientRequest;
};
