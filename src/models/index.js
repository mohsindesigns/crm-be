const { Sequelize } = require('sequelize');
const dbConfig = require('../config/database');

const env = process.env.NODE_ENV || 'development';
const config = dbConfig[env];

const sequelize = new Sequelize(config.database, config.username, config.password, {
  host: config.host,
  port: config.port,
  dialect: config.dialect,
  logging: config.logging,
  pool: config.pool,
  define: config.define,
});

const db = { sequelize, Sequelize };

const modelFiles = [
  'Org',
  'WhiteLabelConfig',
  'Company',
  'DocumentSequence',
  'Role',
  'User',
  'Client',
  'Contact',
  'ServiceType',
  'Package',
  'ClientPackage',
  'WorkflowTemplate',
  'Stage',
  'Transition',
  'Project',
  'ProjectAssignment',
  'ProjectEvent',
  'Artifact',
  'Comment',
  'ProjectCycle',
  'Task',
  'TaskEvent',
  'RecurringTaskRule',
  'KeywordBatch',
  'Keyword',
  'SupportingKeyword',
  'SupportingKeywordRanking',
  'ContentSubmission',
  'Backlink',
  'BlogTask',
  'RankSnapshot',
  'GmbProfile',
  'GmbServiceArea',
  'Invoice',
  'InvoiceLine',
  'Retainer',
  'Payment',
  'PaymentMethod',
  'PaymentSetting',
  'PaymentFeeRule',
  'PersonalContact',
  'PersonalInvoice',
  'PersonalInvoiceLine',
  'PersonalPayment',
  'Worker',
  'Appraisal',
  'Attendance',
  'Holiday',
  'ShiftSchedule',
  'LeaveRequest',
  'PayrollRun',
  'PayrollItem',
  'SalaryBeneficiary',
  'SalarySlip',
  'HrDocument',
  'ContractorInvoice',
  'PayrollSettings',
  'TaxYear',
  'TaxSlab',
  'Notification',
  'NotificationPref',
  'SlaPolicy',
  'PortalNotification',
  'HrDepartment',
  'HrDesignation',
  'DocumentTemplate',
  'CustomerDocument',
  'DocumentEvent',
  'ChatRoom',
  'ChatMember',
  'ChatMessage',
  'ChatReaction',
  'ChatRoomEvent',
  'LeadForm',
  'Lead',
  'LeadEvent',
  'ActivityLog',
  'RequirementFormTemplate',
  'ClientRequest',
  'ExportTemplate',
];

modelFiles.forEach((name) => {
  const model = require(`./${name}`)(sequelize, Sequelize.DataTypes);
  db[name] = model;
});

Object.values(db).forEach((model) => {
  if (model.associate) model.associate(db);
});

module.exports = db;
