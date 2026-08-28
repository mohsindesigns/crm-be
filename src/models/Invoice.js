const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Invoice = sequelize.define('Invoice', {
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
    clientId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'clients', key: 'id' },
    },
    // Traces an installment invoice back to the package sale that generated it —
    // nullable, only set for invoices spawned from ClientService.sellPackage's
    // installment-plan path (see item #24).
    clientPackageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'client_packages', key: 'id' },
    },
    // Ties an auto-generated retainer invoice back to the retainer that produced it —
    // nullable (manual/installment invoices have no retainer). Paired with the unique
    // (retainer_id, issued_at) index in app.js, this is what stops the same retainer
    // from being billed twice for the same day if the invoicing scheduler ever runs
    // more than once around the same cycle (a restart, or more than one server
    // process both running the scheduler).
    retainerId: {
      type: DataTypes.CHAR(36),
      references: { model: 'retainers', key: 'id' },
    },
    number: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    status: {
      type: DataTypes.ENUM('draft', 'sent', 'paid', 'overdue', 'payment_review', 'void'),
      defaultValue: 'draft',
    },
    issuedAt: {
      type: DataTypes.DATEONLY,
    },
    dueAt: {
      type: DataTypes.DATEONLY,
    },
    total: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    notes: {
      type: DataTypes.TEXT,
    },
    // ─── Stripe ────────────────────────────────────────────────────────────────
    // Set when a client starts a card payment from the portal. We create a
    // Checkout Session (mode: "payment") — deliberately NOT a Stripe Invoice,
    // which bills an extra ~0.4% Invoicing fee we don't need since our own
    // InvoiceService already generates the invoice document — and store its id +
    // hosted payment URL here. Column names kept from the pre-rewrite
    // Invoice-based flow to avoid a schema change; they now hold the Checkout
    // Session's id/url. Keeping the id is what lets the webhook map Stripe's
    // callback back to our row, and lets a client who abandoned the page resume
    // the same session instead of generating a second one for the same money.
    // See StripeService.js for the full rationale.
    stripeInvoiceId: {
      type: DataTypes.STRING(255),
    },
    stripeHostedUrl: {
      type: DataTypes.TEXT,
    },
    // Set when the open Stripe page is collecting only PART of the balance (the
    // client chose to pay $500 of $2,000). Null means the page is for the whole
    // remaining balance. Without it, a client coming back to pay the rest would
    // be resumed onto the old, smaller page — see StripeService.startPayment.
    stripePartialAmount: {
      type: DataTypes.DECIMAL(12, 2),
    },
    // Which company (legal entity) issued this invoice — drives the letterhead
    // and the number prefix. Nullable: invoices raised before multi-company
    // existed fall back to whichever companies are flagged for billing.
    companyId: {
      type: DataTypes.CHAR(36),
    },
    // Client-selected payment method for this specific invoice. This lets the
    // invoice carry method-specific numbering/company identity (e.g. Stripe vs
    // Payoneer series) instead of forcing one global billing profile.
    preferredPaymentMethodId: {
      type: DataTypes.CHAR(36),
    },
    // Optional per-invoice checkout link for manual methods (e.g. Payoneer
    // request URL). Shown to the client in the portal when present.
    paymentLinkUrl: {
      type: DataTypes.TEXT,
    },
    /**
     * Credential for the public invoice page (/invoice/:token) — the same
     * pattern as CustomerDocument.publicToken.
     *
     * Portal access is a separate, deliberately-granted thing, and most clients
     * never get it. Without this the invoice email's "View Invoice Online"
     * button pointed at a portal they couldn't sign into, and the only way to
     * pay was the Stripe link for the full balance — so part payments were
     * unreachable for exactly the clients who tend to ask for them.
     *
     * Minted when the invoice is issued; null while it is a draft.
     */
    publicToken: {
      type: DataTypes.STRING(64),
      unique: true,
    },
    // When enabled, the client can choose to pay less than the full remaining balance
    // (partial payment) on the public invoice page or client portal.
    allowPartialPayment: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  }, {
    tableName: 'invoices',
    indexes: [
      { unique: true, fields: ['org_id', 'number'] },
      { fields: ['org_id'] },
      { fields: ['client_id'] },
    ],
  });

  Invoice.associate = (db) => {
    Invoice.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Invoice.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    Invoice.belongsTo(db.ClientPackage, { foreignKey: 'clientPackageId', as: 'clientPackage' });
    Invoice.belongsTo(db.Retainer, { foreignKey: 'retainerId', as: 'retainer' });
    Invoice.belongsTo(db.PaymentMethod, { foreignKey: 'preferredPaymentMethodId', as: 'preferredPaymentMethod' });
    Invoice.hasMany(db.InvoiceLine, { foreignKey: 'invoiceId', as: 'lines' });
    Invoice.hasMany(db.Payment, { foreignKey: 'invoiceId', as: 'payments' });
  };

  // Widens `status` to include 'payment_review' — the state an invoice sits in after a
  // client clicks "I've paid, notify team" in the portal, so it stops showing overdue/
  // unpaid to the client while still being distinct from a confirmed 'paid'.
  Invoice.ensureSchema = async () => {
    await ensureColumns(Invoice);
    await ensureColumnType(Invoice, 'status');
    // ensureColumns adds the column but never an index, and publicToken is a
    // credential — a duplicate would hand one client another's invoice.
    try {
      await Invoice.sequelize.getQueryInterface()
        .addIndex('invoices', ['publicToken'], { unique: true, name: 'invoices_public_token_uq' });
    } catch {
      // Already present.
    }
    // Older prod DBs sometimes never got `total` — Clients list aggregates it.
    try {
      const qi = Invoice.sequelize.getQueryInterface();
      const cols = await qi.describeTable('invoices');
      if (!cols.total) {
        await qi.addColumn('invoices', 'total', {
          type: DataTypes.DECIMAL(12, 2),
          allowNull: false,
          defaultValue: 0,
        });
        // Best-effort backfill from line amounts.
        await Invoice.sequelize.query(`
          UPDATE invoices i
          LEFT JOIN (
            SELECT invoiceId, COALESCE(SUM(amount), 0) AS lineTotal
            FROM invoice_lines
            GROUP BY invoiceId
          ) x ON x.invoiceId = i.id
          SET i.total = COALESCE(x.lineTotal, 0)
          WHERE i.total IS NULL OR i.total = 0
        `).catch(() => {});
        console.warn('[Schema] Added missing invoices.total column.');
      }
    } catch (err) {
      console.error('[Schema] invoices.total ensure failed:', err.message);
    }
  };

  return Invoice;
};
