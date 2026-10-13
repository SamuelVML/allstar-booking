import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, uniqueIndex, text } from "drizzle-orm/sqlite-core";

export const customerAccounts = sqliteTable(
  "customer_accounts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    reminderOptIn: integer("reminder_opt_in", { mode: "boolean" }).notNull().default(true),
    marketingConsent: integer("marketing_consent", { mode: "boolean" }).notNull().default(false),
    loyaltyPoints: integer("loyalty_points").notNull().default(0),
    completedVisits: integer("completed_visits").notNull().default(0),
    lastVisitAt: text("last_visit_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_customer_accounts_phone").on(table.phone)],
);

export const appointments = sqliteTable(
  "appointments",
  {
    id: text("id").primaryKey(),
    reference: text("reference").notNull().unique(),
    bookingRequestId: text("booking_request_id"),
    revision: integer("revision").notNull().default(0),
    source: text("source").notNull().default("online"),
    createdBy: text("created_by"),
    serviceId: text("service_id").notNull(),
    serviceName: text("service_name").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    priceCents: integer("price_cents").notNull(),
    appointmentDate: text("appointment_date").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    customerName: text("customer_name").notNull(),
    customerEmail: text("customer_email").notNull(),
    customerPhone: text("customer_phone").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("confirmed"),
    paymentMethod: text("payment_method").notNull().default("pay_at_shop"),
    paymentStatus: text("payment_status").notNull().default("due_at_shop"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").unique(),
    paymentExpiresAt: text("payment_expires_at"),
    paidAt: text("paid_at"),
    customerAccountId: text("customer_account_id").references(() => customerAccounts.id),
    handlingMinutes: integer("handling_minutes").notNull().default(10),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_appointments_date_status").on(
      table.appointmentDate,
      table.status,
    ),
    // Idempotent website booking retries. See 0008_bookly_bridge.sql.
    uniqueIndex("appointments_request_id").on(table.bookingRequestId).where(sql`${table.bookingRequestId} IS NOT NULL`),
  ],
);

export const loyaltyEvents = sqliteTable(
  "loyalty_events",
  {
    id: text("id").primaryKey(),
    customerAccountId: text("customer_account_id")
      .notNull()
      .references(() => customerAccounts.id, { onDelete: "cascade" }),
    appointmentId: text("appointment_id")
      .notNull()
      .unique()
      .references(() => appointments.id, { onDelete: "cascade" }),
    pointsDelta: integer("points_delta").notNull(),
    eventType: text("event_type").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_loyalty_events_customer").on(table.customerAccountId)],
);

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const appointmentSlots = sqliteTable(
  "appointment_slots",
  {
    slotStart: text("slot_start").primaryKey(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "cascade" }),
  },
  (table) => [index("idx_appointment_slots_appointment").on(table.appointmentId)],
);

export const bookingChanges = sqliteTable("booking_changes", {
  id: text("id").primaryKey(),
  appointmentId: text("appointment_id").notNull().references(() => appointments.id),
  revision: integer("revision").notNull(),
  action: text("action", { enum: ["cancel", "reschedule", "complete"] }).notNull(),
  actorId: text("actor_id").notNull(),
  previousDate: text("previous_date").notNull(),
  previousTime: text("previous_time").notNull(),
  newDate: text("new_date"),
  newTime: text("new_time"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("booking_changes_appointment_revision").on(table.appointmentId, table.revision)]);

export const timeOff = sqliteTable("time_off", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  reason: text("reason").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  removedAt: text("removed_at"),
  removedBy: text("removed_by"),
});
export const timeOffSlots = sqliteTable("time_off_slots", {
  slotStart: text("slot_start").primaryKey(),
  timeOffId: text("time_off_id").notNull().references(() => timeOff.id),
});
export const paymentReceipts = sqliteTable("payment_receipts", {
  id: text("id").primaryKey(),
  appointmentId: text("appointment_id").notNull().unique().references(() => appointments.id),
  amountCents: integer("amount_cents").notNull(),
  method: text("method").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const bookingSettings = sqliteTable("booking_settings", {
  id: integer("id").primaryKey(),
  configJson: text("config_json").notNull(),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedBy: text("updated_by").notNull(),
});

export const paymentRefunds = sqliteTable(
  "payment_refunds",
  {
    id: text("id").primaryKey(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointments.id),
    stripeRefundId: text("stripe_refund_id"),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    requestedBy: text("requested_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("payment_refunds_appointment_id_unique").on(table.appointmentId),
  ],
);

// Calendar integration custody and retry records. See 0008_bookly_bridge.sql.
export const booklyLinks = sqliteTable("bookly_links", {
  localId: text("local_id").primaryKey(), remoteId: text("remote_id").notNull().unique(),
  remoteVersion: text("remote_version").notNull(), localDigest: text("local_digest").notNull(),
  kind: text("kind").notNull().default("appointment"),
});
export const booklyCommands = sqliteTable("bookly_commands", {
  id: text("id").primaryKey(), localId: text("local_id").notNull(), payload: text("payload").notNull(),
  digest: text("digest").notNull(), status: text("status").notNull().default("pending"), error: text("error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("bookly_commands_pending").on(table.localId).where(sql`${table.status} = 'pending'`)]);
export const booklySyncState = sqliteTable("bookly_sync_state", {
  id: integer("id").primaryKey(), lease: text("lease"), leaseUntil: integer("lease_until").notNull().default(0),
  lastSuccess: text("last_success"), error: text("error"),
}, table => [check("bookly_sync_state_singleton", sql`${table.id} = 1`)]);
export const booklyOccupiedSlots = sqliteTable("bookly_occupied_slots", {
  slotStart: text("slot_start").notNull(), appointmentId: text("appointment_id").notNull(),
}, table => [primaryKey({ columns: [table.slotStart, table.appointmentId] })]);
export const booklyCallbackNonces = sqliteTable("bookly_callback_nonces", {
  nonce: text("nonce").primaryKey(), expires: integer("expires").notNull(),
});
export const booklyRevisionGuards = sqliteTable("bookly_revision_guards", {
  id: text("id").primaryKey(), valid: integer("valid").notNull(),
}, table => [check("bookly_revision_guards_valid", sql`${table.valid} = 1`)]);

// Durable side effects of a committed booking change (refund, customer email).
// Written in the same transaction as the change; processed afterwards by
// lib/booking-obligations.ts. See 0009_booking_obligations.sql.
export const bookingObligations = sqliteTable("booking_obligations", {
  id: text("id").primaryKey(),
  appointmentId: text("appointment_id").notNull().references(() => appointments.id),
  changeId: text("change_id").notNull().references(() => bookingChanges.id),
  kind: text("kind", { enum: ["refund", "notify"] }).notNull(),
  status: text("status", { enum: ["pending", "done", "failed"] }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at").notNull().default(0),
  outcome: text("outcome"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [
  uniqueIndex("booking_obligations_change_kind").on(table.changeId, table.kind),
  index("booking_obligations_due").on(table.status, table.nextAttemptAt),
  check("booking_obligations_kind", sql`${table.kind} IN ('refund','notify')`),
  check("booking_obligations_status", sql`${table.status} IN ('pending','done','failed')`),
]);
