module.exports = {
  SYSTEM_ROLES: ['super_admin', 'admin', 'client', 'employee'],

  PROJECT_STATUS: {
    ACTIVE: 'active',
    ON_HOLD: 'on_hold',
    BLOCKED: 'blocked',
    CANCELLED: 'cancelled',
    COMPLETED: 'completed',
  },

  STAGE_TYPE: {
    WORK: 'work',
    APPROVAL: 'approval',
  },

  TRANSITION_ACTION: {
    COMPLETE: 'complete',
    APPROVE: 'approve',
    REJECT: 'reject',
  },

  TASK_STATUS: {
    TODO: 'todo',
    ACCEPTED: 'accepted',
    IN_PROGRESS: 'in_progress',
    SUBMITTED: 'submitted',
    IN_REVIEW: 'in_review',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    DONE: 'done',
  },

  ADVANCE_RULE: {
    SINGLE_ACTION: 'single_action',
    ALL_TASKS_DONE: 'all_tasks_done',
    ALL_TASKS_APPROVED: 'all_tasks_approved',
    ANY_TASK_DONE: 'any_task_done',
    MANUAL: 'manual',
  },

  INVOICE_STATUS: {
    DRAFT: 'draft',
    SENT: 'sent',
    PAID: 'paid',
    OVERDUE: 'overdue',
    PAYMENT_REVIEW: 'payment_review',
    VOID: 'void',
  },

  WORKER_TYPE: {
    EMPLOYEE: 'employee',
    CONTRACTOR: 'contractor',
  },

  PAY_MODEL: {
    SALARY: 'salary',
    PER_DELIVERABLE: 'per_deliverable',
    HOURLY: 'hourly',
    FIXED_INVOICE: 'fixed_invoice',
  },

  PAYROLL_RUN_STATUS: {
    DRAFT: 'draft',
    OPEN_FOR_REVIEW: 'open_for_review',
    LOCKED: 'locked',
    PAID: 'paid',
  },

  HR_DOC_TYPE: {
    APPOINTMENT_LETTER: 'appointment_letter',
    CONFIRMATION_LETTER: 'confirmation_letter',
    BANK_ACCOUNT_OPENING_LETTER: 'bank_account_opening_letter',
    EXPERIENCE_LETTER: 'experience_letter',
    SALARY_CERTIFICATE: 'salary_certificate',
    WARNING_LETTER: 'warning_letter',
  },

  NOTIFICATION_CHANNEL: {
    IN_APP: 'in_app',
    EMAIL: 'email',
    WHATSAPP: 'whatsapp',
  },

  WORKER_STATUS: {
    INVITED: 'invited',
    PROFILE_PENDING: 'profile_pending',
    UNDER_REVIEW: 'under_review',
    ACTIVE: 'active',
    INACTIVE: 'inactive',
  },

  LEAD_STATUS: {
    NEW: 'new',
    CONTACTED: 'contacted',
    QUALIFIED: 'qualified',
    NOT_QUALIFIED: 'not_qualified',
    CONVERTED: 'converted',
    LOST: 'lost',
  },

  LEAD_FORM_FIELD_TYPES: ['text', 'email', 'phone', 'textarea', 'select', 'checkbox', 'multiselect', 'file'],

  DEFAULT_BRAND_COLOR: '#0B1D5E',
};
