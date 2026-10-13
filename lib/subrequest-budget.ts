/** Per-invocation subrequest accounting for background work.
 *
 * Cloudflare counts every outbound fetch and every D1 query or batch made by
 * one Worker invocation against a per-invocation subrequest limit (Workers
 * Free: 50; Workers Paid: higher, see docs/bookly-hardening-checkpoint.md).
 * Background jobs charge a budget before each call and stop at a safe
 * boundary instead of failing mid-operation; the next run resumes.
 */
import { env } from "cloudflare:workers";

export class SubrequestBudgetExhausted extends Error {}

export class SubrequestBudget {
  used = 0;
  constructor(readonly limit: number) {}
  get remaining() { return this.limit - this.used; }
  canAfford(count: number) { return this.used + count <= this.limit; }
  charge(count: number) {
    if (!this.canAfford(count)) throw new SubrequestBudgetExhausted("Subrequest budget reached; the next run continues.");
    this.used += count;
  }
}

/** Closing writes (error state, lease release) run outside the budget. */
export const CLOSING_RESERVE = 2;
/** Default when BOOKLY_SUBREQUEST_BUDGET is unset: fits Workers Free (50)
 * with headroom for the invoking request's own calls (the signed callback
 * spends 2, staff authentication may spend 1). */
export const DEFAULT_SUBREQUEST_BUDGET = 40;
const MIN_BUDGET = 30;
const MAX_BUDGET = 9_500;

/** Total subrequests one background invocation may spend, including the
 * closing reserve. Set BOOKLY_SUBREQUEST_BUDGET only after confirming the
 * account's Workers plan. Invalid values fall back to the default. */
export function configuredSubrequestBudget() {
  const raw = (env as unknown as { BOOKLY_SUBREQUEST_BUDGET?: string }).BOOKLY_SUBREQUEST_BUDGET;
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(value)) return DEFAULT_SUBREQUEST_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, value));
}

/** Budget for one background invocation, net of the closing reserve. */
export function backgroundBudget() {
  return new SubrequestBudget(configuredSubrequestBudget() - CLOSING_RESERVE);
}

const INNER = Symbol("inner");
type Wrapped = D1PreparedStatement & { [INNER]: D1PreparedStatement };

function meterStatement(statement: D1PreparedStatement, budget: SubrequestBudget): D1PreparedStatement {
  const wrapper = {
    [INNER]: statement,
    bind: (...values: unknown[]) => meterStatement(statement.bind(...values), budget),
    first: (column?: string) => { budget.charge(1); return column === undefined ? statement.first() : statement.first(column); },
    all: () => { budget.charge(1); return statement.all(); },
    run: () => { budget.charge(1); return statement.run(); },
    raw: (options?: { columnNames?: boolean }) => { budget.charge(1); return statement.raw(options as { columnNames: true }); },
  };
  return wrapper as unknown as D1PreparedStatement;
}

/** D1 handle whose queries and batches each charge one subrequest. A batch
 * is a single request however many statements it carries. */
export function meteredDatabase(database: D1Database, budget: SubrequestBudget): D1Database {
  return {
    prepare: (sql: string) => meterStatement(database.prepare(sql), budget),
    batch(statements: D1PreparedStatement[]) {
      budget.charge(1);
      return database.batch(statements.map(statement => (statement as Wrapped)[INNER] ?? statement));
    },
  } as unknown as D1Database;
}
