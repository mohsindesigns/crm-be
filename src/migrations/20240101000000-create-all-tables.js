'use strict';
const { DataTypes } = require('sequelize');

module.exports = {
  async up(queryInterface) {
    const qi = queryInterface;

    // 1. orgs
    await qi.createTable('orgs', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      subdomain: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      plan: { type: DataTypes.STRING(50), defaultValue: 'internal' },
      status: { type: DataTypes.ENUM('active', 'suspended', 'cancelled'), defaultValue: 'active' },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 2. white_label_configs
    await qi.createTable('white_label_configs', {
      orgId: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false, references: { model: 'orgs', key: 'id' } },
      brandName: { type: DataTypes.STRING(100), defaultValue: 'Mohsin Designs Project Management' },
      logoUrl: { type: DataTypes.TEXT },
      primaryColor: { type: DataTypes.STRING(20), defaultValue: '#0B1D5E' },
      customDomain: { type: DataTypes.STRING(255) },
      emailFrom: { type: DataTypes.STRING(255) },
    });

    // 3. roles
    await qi.createTable('roles', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      name: { type: DataTypes.STRING(100), allowNull: false },
      key: { type: DataTypes.STRING(100), allowNull: false },
      permissions: { type: DataTypes.JSON, defaultValue: {} },
      isSystemRole: { type: DataTypes.BOOLEAN, defaultValue: false },
      color: { type: DataTypes.STRING(20) },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('roles', ['orgId', 'key'], { unique: true });

    // 4. users
    await qi.createTable('users', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      roleId: { type: DataTypes.CHAR(36), references: { model: 'roles', key: 'id' } },
      name: { type: DataTypes.STRING(255), allowNull: false },
      email: { type: DataTypes.STRING(255), allowNull: false },
      passwordHash: { type: DataTypes.STRING(255), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      mustChangePassword: { type: DataTypes.BOOLEAN, defaultValue: false },
      lastLoginAt: { type: DataTypes.DATE },
      avatarUrl: { type: DataTypes.TEXT },
      phone: { type: DataTypes.STRING(50) },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('users', ['orgId', 'email'], { unique: true });

    // 5. clients
    await qi.createTable('clients', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      name: { type: DataTypes.STRING(255), allowNull: false },
      status: { type: DataTypes.ENUM('active', 'paused', 'churned'), defaultValue: 'active' },
      defaultCurrency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
      notes: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 6. contacts
    await qi.createTable('contacts', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      clientId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'clients', key: 'id' } },
      userId: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      name: { type: DataTypes.STRING(255), allowNull: false },
      email: { type: DataTypes.STRING(255) },
      phone: { type: DataTypes.STRING(50) },
      role: { type: DataTypes.STRING(100) },
      portalAccess: { type: DataTypes.BOOLEAN, defaultValue: false },
    });

    // 7. service_types
    await qi.createTable('service_types', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      key: { type: DataTypes.STRING(100), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      icon: { type: DataTypes.STRING(50) },
    });
    await qi.addIndex('service_types', ['orgId', 'key'], { unique: true });

    // 8. packages
    await qi.createTable('packages', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      serviceTypeKey: { type: DataTypes.STRING(100), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      tier: { type: DataTypes.STRING(50) },
      price: { type: DataTypes.DECIMAL(12, 2) },
      currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
      features: { type: DataTypes.JSON },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
    });

    // 9. workflow_templates
    await qi.createTable('workflow_templates', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      serviceTypeKey: { type: DataTypes.STRING(100), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      version: { type: DataTypes.INTEGER, defaultValue: 1 },
      isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
      isRecurring: { type: DataTypes.BOOLEAN, defaultValue: false },
    });

    // 10. stages
    await qi.createTable('stages', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      templateId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workflow_templates', key: 'id' } },
      key: { type: DataTypes.STRING(100), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      orderIndex: { type: DataTypes.INTEGER, allowNull: false },
      ownerRoleSlot: { type: DataTypes.STRING(100) },
      stageType: { type: DataTypes.ENUM('work', 'approval'), defaultValue: 'work' },
      requiresArtifact: { type: DataTypes.BOOLEAN, defaultValue: false },
      isTerminal: { type: DataTypes.BOOLEAN, defaultValue: false },
      advanceRule: { type: DataTypes.ENUM('single_action', 'all_tasks_done', 'all_tasks_approved', 'any_task_done', 'manual'), defaultValue: 'single_action' },
      taskType: { type: DataTypes.STRING(100) },
      approvalGranularity: { type: DataTypes.ENUM('batch', 'per_item') },
      description: { type: DataTypes.TEXT },
    });
    await qi.addIndex('stages', ['templateId', 'key'], { unique: true });

    // 11. transitions
    await qi.createTable('transitions', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      templateId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workflow_templates', key: 'id' } },
      fromStageKey: { type: DataTypes.STRING(100), allowNull: false },
      action: { type: DataTypes.ENUM('complete', 'approve', 'reject'), allowNull: false },
      reasonCategory: { type: DataTypes.STRING(100) },
      toStageKey: { type: DataTypes.STRING(100), allowNull: false },
    });

    // 12. projects
    await qi.createTable('projects', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      clientId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'clients', key: 'id' } },
      name: { type: DataTypes.STRING(255), allowNull: false },
      serviceTypeKey: { type: DataTypes.STRING(100), allowNull: false },
      workflowTemplateId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workflow_templates', key: 'id' } },
      packageId: { type: DataTypes.CHAR(36), references: { model: 'packages', key: 'id' } },
      currentStageKey: { type: DataTypes.STRING(100), allowNull: false },
      status: { type: DataTypes.ENUM('active', 'on_hold', 'blocked', 'cancelled', 'completed'), defaultValue: 'active' },
      startDate: { type: DataTypes.DATEONLY },
      deliveryDate: { type: DataTypes.DATEONLY },
      isRecurring: { type: DataTypes.BOOLEAN, defaultValue: false },
      description: { type: DataTypes.TEXT },
      createdBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 13. project_assignments
    await qi.createTable('project_assignments', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      roleSlot: { type: DataTypes.STRING(100), allowNull: false },
      userId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'users', key: 'id' } },
    });
    await qi.addIndex('project_assignments', ['projectId', 'roleSlot'], { unique: true });

    // 14. project_events
    await qi.createTable('project_events', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      fromStageKey: { type: DataTypes.STRING(100) },
      toStageKey: { type: DataTypes.STRING(100), allowNull: false },
      action: { type: DataTypes.STRING(50), allowNull: false },
      reasonCategory: { type: DataTypes.STRING(100) },
      actorUserId: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      note: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 15. artifacts
    await qi.createTable('artifacts', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      stageKey: { type: DataTypes.STRING(100), allowNull: false },
      fileUrl: { type: DataTypes.TEXT, allowNull: false },
      fileName: { type: DataTypes.STRING(255) },
      fileSize: { type: DataTypes.INTEGER },
      mimeType: { type: DataTypes.STRING(100) },
      kind: { type: DataTypes.STRING(50) },
      uploadedBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 16. comments
    await qi.createTable('comments', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      stageKey: { type: DataTypes.STRING(100) },
      authorId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'users', key: 'id' } },
      body: { type: DataTypes.TEXT, allowNull: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 17. project_cycles
    await qi.createTable('project_cycles', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      period: { type: DataTypes.STRING(20), allowNull: false },
      status: { type: DataTypes.ENUM('active', 'completed', 'cancelled'), defaultValue: 'active' },
    });
    await qi.addIndex('project_cycles', ['projectId', 'period'], { unique: true });

    // 18. tasks
    await qi.createTable('tasks', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      cycleId: { type: DataTypes.CHAR(36), references: { model: 'project_cycles', key: 'id' } },
      stageKey: { type: DataTypes.STRING(100), allowNull: false },
      type: { type: DataTypes.STRING(100), allowNull: false },
      title: { type: DataTypes.STRING(255), allowNull: false },
      assigneeId: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      reviewerId: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      status: { type: DataTypes.ENUM('todo', 'in_progress', 'submitted', 'in_review', 'approved', 'rejected', 'done'), defaultValue: 'todo' },
      reasonCategory: { type: DataTypes.STRING(100) },
      refTable: { type: DataTypes.STRING(100) },
      refId: { type: DataTypes.CHAR(36) },
      dueAt: { type: DataTypes.DATEONLY },
      autoCreated: { type: DataTypes.BOOLEAN, defaultValue: false },
      createdBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      completedAt: { type: DataTypes.DATE },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 19. task_events
    await qi.createTable('task_events', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      taskId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'tasks', key: 'id' } },
      fromStatus: { type: DataTypes.STRING(50) },
      toStatus: { type: DataTypes.STRING(50), allowNull: false },
      actorUserId: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      reasonCategory: { type: DataTypes.STRING(100) },
      note: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 20. keywords
    await qi.createTable('keywords', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      cycleId: { type: DataTypes.CHAR(36), references: { model: 'project_cycles', key: 'id' } },
      primaryKeyword: { type: DataTypes.STRING(255), allowNull: false },
      secondaryKeywords: { type: DataTypes.TEXT },
      kd: { type: DataTypes.INTEGER },
      volume: { type: DataTypes.INTEGER },
      targetUrl: { type: DataTypes.TEXT },
      pageName: { type: DataTypes.STRING(255) },
      status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
      batchId: { type: DataTypes.CHAR(36) },
      createdBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 21. content_submissions
    await qi.createTable('content_submissions', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      pageName: { type: DataTypes.STRING(255), allowNull: false },
      keywordIds: { type: DataTypes.JSON },
      fileUrl: { type: DataTypes.TEXT },
      fileName: { type: DataTypes.STRING(255) },
      submittedBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 22. backlinks
    await qi.createTable('backlinks', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      cycleId: { type: DataTypes.CHAR(36), references: { model: 'project_cycles', key: 'id' } },
      sourceUrl: { type: DataTypes.TEXT, allowNull: false },
      targetUrl: { type: DataTypes.TEXT },
      anchorText: { type: DataTypes.STRING(255) },
      da: { type: DataTypes.INTEGER },
      linkType: { type: DataTypes.ENUM('guest', 'directory', 'profile', 'forum', 'blog_comment', 'other'), defaultValue: 'other' },
      isIndexed: { type: DataTypes.BOOLEAN, defaultValue: false },
      indexedCheckedAt: { type: DataTypes.DATE },
      addedBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 23. blog_tasks
    await qi.createTable('blog_tasks', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      cycleId: { type: DataTypes.CHAR(36), references: { model: 'project_cycles', key: 'id' } },
      title: { type: DataTypes.STRING(255), allowNull: false },
      targetKeywords: { type: DataTypes.TEXT },
      fileUrl: { type: DataTypes.TEXT },
      publishedUrl: { type: DataTypes.TEXT },
      createdBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 24. rank_snapshots
    await qi.createTable('rank_snapshots', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      projectId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'projects', key: 'id' } },
      keywordId: { type: DataTypes.CHAR(36), references: { model: 'keywords', key: 'id' } },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      position: { type: DataTypes.INTEGER },
      url: { type: DataTypes.TEXT },
      searchEngine: { type: DataTypes.STRING(50), defaultValue: 'google' },
    });

    // 25. invoices
    await qi.createTable('invoices', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      clientId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'clients', key: 'id' } },
      number: { type: DataTypes.STRING(50), allowNull: false },
      currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
      status: { type: DataTypes.ENUM('draft', 'sent', 'paid', 'overdue', 'void'), defaultValue: 'draft' },
      issuedAt: { type: DataTypes.DATEONLY },
      dueAt: { type: DataTypes.DATEONLY },
      total: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
      notes: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('invoices', ['orgId', 'number'], { unique: true });

    // 26. invoice_lines
    await qi.createTable('invoice_lines', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      invoiceId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'invoices', key: 'id' } },
      description: { type: DataTypes.STRING(500), allowNull: false },
      qty: { type: DataTypes.DECIMAL(10, 2), defaultValue: 1 },
      unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    });

    // 27. retainers
    await qi.createTable('retainers', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      clientId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'clients', key: 'id' } },
      packageId: { type: DataTypes.CHAR(36), references: { model: 'packages', key: 'id' } },
      currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      cycle: { type: DataTypes.ENUM('monthly', 'quarterly', 'annual'), defaultValue: 'monthly' },
      nextInvoiceDate: { type: DataTypes.DATEONLY },
      status: { type: DataTypes.ENUM('active', 'paused', 'cancelled'), defaultValue: 'active' },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 28. payments
    await qi.createTable('payments', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      invoiceId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'invoices', key: 'id' } },
      provider: { type: DataTypes.ENUM('manual', 'stripe', 'paddle', 'payfast'), defaultValue: 'manual' },
      providerRef: { type: DataTypes.STRING(255) },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      paidAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    });

    // 29. workers
    await qi.createTable('workers', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      userId: { type: DataTypes.CHAR(36), allowNull: false, unique: true, references: { model: 'users', key: 'id' } },
      workerType: { type: DataTypes.ENUM('employee', 'contractor'), defaultValue: 'employee' },
      payModel: { type: DataTypes.ENUM('salary', 'per_deliverable', 'hourly', 'fixed_invoice'), defaultValue: 'salary' },
      designation: { type: DataTypes.STRING(150) },
      department: { type: DataTypes.STRING(150) },
      joiningDate: { type: DataTypes.DATEONLY },
      probationEndDate: { type: DataTypes.DATEONLY },
      confirmationDate: { type: DataTypes.DATEONLY },
      salaryBase: { type: DataTypes.DECIMAL(12, 2) },
      currency: { type: DataTypes.STRING(10), defaultValue: 'PKR' },
      bankName: { type: DataTypes.STRING(255) },
      bankAccountTitle: { type: DataTypes.STRING(255) },
      bankAccountNumber: { type: DataTypes.STRING(50) },
      iban: { type: DataTypes.STRING(50) },
      cnic: { type: DataTypes.STRING(20) },
      address: { type: DataTypes.TEXT },
      emergencyContact: { type: DataTypes.STRING(255) },
      emergencyPhone: { type: DataTypes.STRING(50) },
      status: { type: DataTypes.ENUM('invited', 'profile_pending', 'under_review', 'active', 'inactive'), defaultValue: 'invited' },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 30. attendances
    await qi.createTable('attendances', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      workerId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workers', key: 'id' } },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      checkIn: { type: DataTypes.TIME },
      checkOut: { type: DataTypes.TIME },
      status: { type: DataTypes.ENUM('present', 'absent', 'leave', 'half_day', 'holiday', 'weekend'), defaultValue: 'present' },
      hours: { type: DataTypes.DECIMAL(5, 2) },
      source: { type: DataTypes.STRING(50), defaultValue: 'manual' },
      note: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('attendances', ['workerId', 'date'], { unique: true });

    // 31. leave_requests
    await qi.createTable('leave_requests', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      workerId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workers', key: 'id' } },
      type: { type: DataTypes.ENUM('annual', 'sick', 'casual', 'unpaid', 'other'), allowNull: false },
      fromDate: { type: DataTypes.DATEONLY, allowNull: false },
      toDate: { type: DataTypes.DATEONLY, allowNull: false },
      days: { type: DataTypes.DECIMAL(4, 1) },
      reason: { type: DataTypes.TEXT },
      status: { type: DataTypes.ENUM('requested', 'approved', 'rejected'), defaultValue: 'requested' },
      approverId: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      approverNote: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 32. payroll_runs
    await qi.createTable('payroll_runs', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'orgs', key: 'id' } },
      period: { type: DataTypes.STRING(20), allowNull: false },
      status: { type: DataTypes.ENUM('draft', 'open_for_review', 'locked', 'paid'), defaultValue: 'draft' },
      workingDaysPerMonth: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 26 },
      createdBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('payroll_runs', ['orgId', 'period'], { unique: true });

    // 33. payroll_items
    await qi.createTable('payroll_items', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      payrollRunId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'payroll_runs', key: 'id' } },
      workerId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workers', key: 'id' } },
      presentDays: { type: DataTypes.INTEGER, defaultValue: 0 },
      absentDays: { type: DataTypes.INTEGER, defaultValue: 0 },
      leaveDays: { type: DataTypes.INTEGER, defaultValue: 0 },
      halfDays: { type: DataTypes.INTEGER, defaultValue: 0 },
      overtimeHours: { type: DataTypes.DECIMAL(6, 2), defaultValue: 0 },
      base: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
      additions: { type: DataTypes.JSON, defaultValue: {} },
      deductions: { type: DataTypes.JSON, defaultValue: {} },
      computedGross: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
      computedNet: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
      employeeStatus: { type: DataTypes.ENUM('pending_review', 'confirmed', 'concern_raised', 'rectifying'), defaultValue: 'pending_review' },
      employeeConfirmedAt: { type: DataTypes.DATE },
      concernNote: { type: DataTypes.TEXT },
      adminNote: { type: DataTypes.TEXT },
      isLocked: { type: DataTypes.BOOLEAN, defaultValue: false },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 34. salary_slips
    await qi.createTable('salary_slips', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      payrollItemId: { type: DataTypes.CHAR(36), allowNull: false, unique: true, references: { model: 'payroll_items', key: 'id' } },
      fileUrl: { type: DataTypes.STRING(500), allowNull: false },
      generatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      sentAt: { type: DataTypes.DATE },
    });

    // 35. hr_documents
    await qi.createTable('hr_documents', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      workerId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workers', key: 'id' } },
      type: { type: DataTypes.ENUM('offer_letter', 'appointment_letter', 'confirmation_letter', 'experience_letter', 'warning_letter', 'nda', 'contract', 'cnic_copy', 'other'), allowNull: false },
      label: { type: DataTypes.STRING(255) },
      fileUrl: { type: DataTypes.STRING(500), allowNull: false },
      fileName: { type: DataTypes.STRING(255) },
      uploadedBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      expiresAt: { type: DataTypes.DATEONLY },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 36. contractor_invoices
    await qi.createTable('contractor_invoices', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      workerId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workers', key: 'id' } },
      period: { type: DataTypes.STRING(20), allowNull: false },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      currency: { type: DataTypes.STRING(10), defaultValue: 'PKR' },
      description: { type: DataTypes.TEXT },
      fileUrl: { type: DataTypes.STRING(500) },
      status: { type: DataTypes.ENUM('submitted', 'approved', 'rejected', 'paid'), defaultValue: 'submitted' },
      approvedBy: { type: DataTypes.CHAR(36), references: { model: 'users', key: 'id' } },
      paidAt: { type: DataTypes.DATE },
      note: { type: DataTypes.TEXT },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // 37. payroll_settings
    await qi.createTable('payroll_settings', {
      orgId: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false, references: { model: 'orgs', key: 'id' } },
      payDayOfMonth: { type: DataTypes.INTEGER, defaultValue: 30 },
      currency: { type: DataTypes.STRING(10), defaultValue: 'PKR' },
      workingHoursPerDay: { type: DataTypes.DECIMAL(4, 2), defaultValue: 8.0 },
      workingDaysPerMonth: { type: DataTypes.INTEGER, defaultValue: 26 },
      otMultiplier: { type: DataTypes.DECIMAL(4, 2), defaultValue: 1.5 },
      halfDayDeductionFactor: { type: DataTypes.DECIMAL(4, 2), defaultValue: 0.5 },
      leavePolicyJson: { type: DataTypes.JSON },
      deductionRulesJson: { type: DataTypes.JSON },
      allowanceRulesJson: { type: DataTypes.JSON },
      emailSlipToEmployee: { type: DataTypes.BOOLEAN, defaultValue: true },
      requireEmployeeConfirmation: { type: DataTypes.BOOLEAN, defaultValue: true },
      employeeReviewWindowDays: { type: DataTypes.INTEGER, defaultValue: 3 },
    });

    // 38. notifications
    await qi.createTable('notifications', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      recipientId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'users', key: 'id' } },
      channel: { type: DataTypes.ENUM('in_app', 'email'), defaultValue: 'in_app' },
      type: { type: DataTypes.STRING(80), allowNull: false },
      title: { type: DataTypes.STRING(255), allowNull: false },
      body: { type: DataTypes.TEXT },
      refTable: { type: DataTypes.STRING(50) },
      refId: { type: DataTypes.CHAR(36) },
      isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
      readAt: { type: DataTypes.DATE },
      createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('notifications', ['recipientId', 'isRead']);

    // 39. notification_prefs
    await qi.createTable('notification_prefs', {
      userId: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false, references: { model: 'users', key: 'id' } },
      emailEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
      inAppEnabled: { type: DataTypes.BOOLEAN, defaultValue: true },
      muteUntil: { type: DataTypes.DATE },
      preferences: { type: DataTypes.JSON, defaultValue: {} },
    });

    // 40. sla_policies
    await qi.createTable('sla_policies', {
      id: { type: DataTypes.CHAR(36), primaryKey: true, allowNull: false },
      orgId: { type: DataTypes.CHAR(36), allowNull: false },
      templateId: { type: DataTypes.CHAR(36), allowNull: false, references: { model: 'workflow_templates', key: 'id' } },
      stageKey: { type: DataTypes.STRING(80), allowNull: false },
      targetHours: { type: DataTypes.INTEGER, allowNull: false },
      warnAt: { type: DataTypes.INTEGER },
      escalateToRoleSlot: { type: DataTypes.STRING(80) },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
    });
    await qi.addIndex('sla_policies', ['templateId', 'stageKey'], { unique: true });
  },

  async down(queryInterface) {
    const qi = queryInterface;
    // Drop in reverse dependency order
    await qi.dropTable('sla_policies');
    await qi.dropTable('notification_prefs');
    await qi.dropTable('notifications');
    await qi.dropTable('payroll_settings');
    await qi.dropTable('contractor_invoices');
    await qi.dropTable('hr_documents');
    await qi.dropTable('salary_slips');
    await qi.dropTable('payroll_items');
    await qi.dropTable('payroll_runs');
    await qi.dropTable('leave_requests');
    await qi.dropTable('attendances');
    await qi.dropTable('workers');
    await qi.dropTable('payments');
    await qi.dropTable('retainers');
    await qi.dropTable('invoice_lines');
    await qi.dropTable('invoices');
    await qi.dropTable('rank_snapshots');
    await qi.dropTable('blog_tasks');
    await qi.dropTable('backlinks');
    await qi.dropTable('content_submissions');
    await qi.dropTable('keywords');
    await qi.dropTable('task_events');
    await qi.dropTable('tasks');
    await qi.dropTable('project_cycles');
    await qi.dropTable('comments');
    await qi.dropTable('artifacts');
    await qi.dropTable('project_events');
    await qi.dropTable('project_assignments');
    await qi.dropTable('projects');
    await qi.dropTable('transitions');
    await qi.dropTable('stages');
    await qi.dropTable('workflow_templates');
    await qi.dropTable('packages');
    await qi.dropTable('service_types');
    await qi.dropTable('contacts');
    await qi.dropTable('clients');
    await qi.dropTable('users');
    await qi.dropTable('roles');
    await qi.dropTable('white_label_configs');
    await qi.dropTable('orgs');
  },
};
