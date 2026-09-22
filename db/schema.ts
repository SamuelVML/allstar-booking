import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, uniqueIndex, text } from "drizzle-orm/sqlite-core";

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


export const launchListSubscribers = sqliteTable("launch_list_subscribers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  consent: integer("consent", { mode: "boolean" }).notNull().default(true),
  source: text("source").notNull().default("mobile_barber_launch_list"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
