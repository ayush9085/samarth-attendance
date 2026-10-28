import "server-only";
import postgres from "postgres";
import { getDatabaseUrl, getDisplayTimezone, getGeofenceConfig } from "./config";
import { attendanceClosedError } from "./attendance-closed";
import { hasErrorCode, PG } from "./pg-errors";
import { connectionOptions } from "./db-options";
import type { NewSubmission, Submission, SubmissionFilters, SubmissionStats } from "@/types/submission";

/**
 * Postgres access layer. All queries use tagged-template parameters
 * (never string concatenation), so user input cannot inject SQL.
 */

const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export function db(): postgres.Sql {
  if (!globalForDb.sql) {
    const url = getDatabaseUrl();
    globalForDb.sql = postgres(url, {
      ...connectionOptions(url),
      max: Number(process.env.PGMAXCONNECTIONS || 20),
      idle_timeout: 20,
      connect_timeout: 10,
      transform: postgres.camel, // snake_case columns → camelCase fields
    });
  }
  return globalForDb.sql;
}

const MAX_PAGE_SIZE = 200;

const COLUMNS = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  id, name, sap_id, school, course, specialization, batch, event_rating, content_relevance, suggestions,
  designation, institution, email, mobile, department, member_id,
  latitude, longitude, accuracy_m, position_captured_at, distance_m, geofence_status, low_accuracy,
  target_latitude, target_longitude, radius_m, client_distance_m, verification_id, user_agent, created_at`;

/**
 * Store a check-in. The verification is first claimed in `used_verifications`
 * (same transaction), so a verification can never be used twice — even after
 * "Clear All Data" empties `submissions`. A second claim raises 23505.
 */
export async function insertSubmission(s: NewSubmission): Promise<Submission> {
  return db().begin(async (sql) => {
    // Housekeeping: prune expired verifications probabilistically (~2% of inserts)
    // outside the locked section, avoiding severe table-lock contention during concurrent bursts.
    if (s.verificationId && Math.random() < 0.02) {
      await sql`DELETE FROM used_verifications WHERE expires_at < now() - interval '1 hour'`;
    }
    // Never wait more than 10 s for the lock (e.g. behind a stuck open/close); fail instead.
    await sql`SET LOCAL lock_timeout = '10s'`;
    // Authoritative open/closed check for EVERY insert, inside this transaction.
    // A transaction-scoped shared advisory lock orders it against setAttendanceOpen (which
    // takes the same lock exclusively): a "close" waits for check-ins already in flight,
    // and check-ins arriving during a close wait for it and then see "closed". This works
    // whether or not the settings row exists, and writes nothing (unlike SELECT … FOR SHARE).
    await sql`SELECT pg_advisory_xact_lock_shared(${ATTENDANCE_LOCK_KEY}::bigint)`;
    if (!(await readAttendanceOpen(sql))) throw attendanceClosedError();

    if (s.verificationId) {
      await sql`
        INSERT INTO used_verifications (verification_id, expires_at)
        VALUES (${s.verificationId}, ${s.verificationExpiresAt ?? new Date(Date.now() + 10 * 60 * 1000)})`;
    }
    return insertSubmissionRow(sql, s);
  }) as Promise<Submission>;
}

async function insertSubmissionRow(sql: postgres.TransactionSql, s: NewSubmission): Promise<Submission> {
  const [row] = await sql<Submission[]>`
    INSERT INTO submissions (
      name, sap_id, school, course, specialization, batch,
      event_rating, content_relevance, suggestions,
      designation, institution, email, mobile,
      latitude, longitude, accuracy_m, position_captured_at,
      distance_m, geofence_status, low_accuracy, target_latitude, target_longitude, radius_m,
      client_distance_m, verification_id, user_agent, ip_hash
    ) VALUES (
      ${s.name}, ${s.sapId ?? null}, ${s.school ?? null}, ${s.course ?? null}, ${s.specialization ?? null}, ${s.batch ?? null},
      ${s.eventRating ?? null}, ${s.contentRelevance ?? null}, ${s.suggestions || null},
      ${s.designation ?? null}, ${s.institution ?? null}, ${s.email ?? null}, ${s.mobile ?? null},
      ${s.latitude}, ${s.longitude}, ${s.accuracyM}, ${s.positionCapturedAt},
      ${s.distanceM}, ${s.geofenceStatus}, ${s.lowAccuracy},
      ${s.targetLatitude}, ${s.targetLongitude}, ${s.radiusM},
      ${s.clientDistanceM}, ${s.verificationId}, ${s.userAgent}, ${s.ipHash}
    )
    RETURNING ${COLUMNS(sql)}`;
  return row;
}

function whereClause(sql: postgres.Sql, f: SubmissionFilters) {
  const conditions = [];
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    conditions.push(sql`(
      name ILIKE ${like} OR sap_id ILIKE ${like} OR school ILIKE ${like} OR course ILIKE ${like}
      OR specialization ILIKE ${like} OR batch ILIKE ${like}
      OR designation ILIKE ${like} OR institution ILIKE ${like}
      OR email ILIKE ${like} OR mobile ILIKE ${like}
      OR member_id ILIKE ${like} OR department ILIKE ${like}
    )`);
  }
  if (f.institution) conditions.push(sql`institution = ${f.institution}`);
  if (f.status) conditions.push(sql`geofence_status = ${f.status}`);
  if (conditions.length === 0) return sql``;
  return sql`WHERE ${conditions.reduce((acc, c) => sql`${acc} AND ${c}`)}`;
}

export async function listSubmissions(
  f: SubmissionFilters,
): Promise<{ rows: Submission[]; total: number; page: number; pageSize: number }> {
  const sql = db();
  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), MAX_PAGE_SIZE);
  const page = Math.max(f.page ?? 1, 1);
  const where = whereClause(sql, f);
  const order = f.sort === "oldest" ? sql`created_at ASC` : sql`created_at DESC`;

  const [rows, [{ count }]] = await Promise.all([
    sql<Submission[]>`
      SELECT ${COLUMNS(sql)}
      FROM submissions ${where}
      ORDER BY ${order}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM submissions ${where}`,
  ]);
  return { rows, total: count, page, pageSize };
}

/** All matching rows (for CSV export), capped to keep memory bounded. */
export async function exportSubmissions(f: SubmissionFilters, limit = 50_000): Promise<Submission[]> {
  const sql = db();
  const order = f.sort === "oldest" ? sql`created_at ASC` : sql`created_at DESC`;
  return sql<Submission[]>`
    SELECT ${COLUMNS(sql)}
    FROM submissions ${whereClause(sql, f)}
    ORDER BY ${order}
    LIMIT ${limit}`;
}

export async function getStats(tz = getDisplayTimezone()): Promise<SubmissionStats> {
  const [row] = await db()<SubmissionStats[]>`
    SELECT count(*)::int                                                    AS total,
           count(*) FILTER (WHERE geofence_status = 'WITHIN_RANGE')::int    AS within,
           count(*) FILTER (WHERE geofence_status = 'OUTSIDE_RANGE')::int   AS outside,
           count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})::int AS today
    FROM submissions`;
  return row;
}

/**
 * Permanently delete every attendance record (the `submissions` table only) and
 * write a permanent audit entry — in one transaction: either both happen or neither.
 *
 * A plain DELETE (not TRUNCATE) on purpose: it takes only row-level locks, so check-ins
 * and dashboard reads keep working while it runs; it is MVCC-safe for concurrent
 * readers; it needs no TRUNCATE privilege; and its row count is exact. Dead rows are
 * reclaimed by autovacuum. Schema, used_verifications (replay guard), admin accounts
 * and settings are untouched.
 */
export async function clearAllSubmissions(actor: string): Promise<number> {
  return db().begin(async (sql) => {
    // Fail after 10 s instead of hanging if another session holds row locks (e.g. a stuck
    // transaction). Plain check-in INSERTs never lock existing rows, so they don't trigger this.
    await sql`SET LOCAL lock_timeout = '10s'`;
    const { count } = await sql`DELETE FROM submissions`;
    await sql`
      INSERT INTO admin_audit_log (actor, action, details)
      VALUES (${actor}, 'clear_all_attendance', ${sql.json({ deleted: count })})`;
    return count;
  }) as Promise<number>;
}

export interface AuditEntry {
  at: Date;
  actor: string;
  details: { deleted?: number };
}

/** The most recent "Clear All Data", for display on the dashboard. */
export async function getLastClearAll(): Promise<AuditEntry | null> {
  const [row] = await db()<AuditEntry[]>`
    SELECT at, actor, details FROM admin_audit_log
    WHERE action = 'clear_all_attendance'
    ORDER BY at DESC LIMIT 1`;
  return row ?? null;
}

export async function listInstitutions(): Promise<string[]> {
  const rows = await db()<{ institution: string }[]>`
    SELECT DISTINCT institution FROM submissions WHERE institution IS NOT NULL ORDER BY institution`;
  return rows.map((r) => r.institution);
}

/** Advisory-lock key serialising check-ins against open/close changes (arbitrary, app-wide). */
export const ATTENDANCE_LOCK_KEY = 7_201_001;

/** updated_by of the migration's default row — deliberately not a valid admin username. */
export const DEFAULT_SETTING_ACTOR = "(default)";

/** Postgres "undefined_table" — the schema migration hasn't been applied to this database. */
export function isUndefinedTable(err: unknown): boolean {
  return hasErrorCode(err, PG.UNDEFINED_TABLE);
}

let warnedMalformedSetting = false;

/** Strict: only a stored JSON boolean decides; anything else is treated as closed (logged once per process). */
function parseAttendanceOpen(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (!warnedMalformedSetting) {
    warnedMalformedSetting = true;
    console.warn("[settings] attendance_open has a non-boolean value; treating attendance as closed:", value);
  }
  return false;
}

/** Current setting inside a transaction (call after taking the advisory lock). */
async function readAttendanceOpen(sql: postgres.TransactionSql): Promise<boolean> {
  try {
    // Savepoint: if the table doesn't exist yet, only this statement is rolled back.
    const rows = await sql.savepoint(
      (sp) => sp<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'attendance_open'`,
    );
    return rows.length === 0 ? true : parseAttendanceOpen(rows[0].value);
  } catch (err) {
    if (isUndefinedTable(err)) return true; // un-migrated database: behave as before (open)
    throw err;
  }
}

export interface AttendanceStatus {
  open: boolean;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Whether check-ins are currently accepted (admin-controlled). Defaults to open when
 * the setting has never been changed — or when the app_settings table doesn't exist
 * yet (migration not applied), so an un-migrated database keeps working as before.
 */
export async function getAttendanceStatus(): Promise<AttendanceStatus> {
  try {
    const [row] = await db()<{ value: unknown; updatedAt: Date; updatedBy: string }[]>`
      SELECT value, updated_at, updated_by FROM app_settings WHERE key = 'attendance_open'`;
    // No row, or only the migration's default row → never changed by an admin
    if (!row) return { open: true, updatedAt: null, updatedBy: null };
    const changedByAdmin = row.updatedBy !== DEFAULT_SETTING_ACTOR;
    return {
      open: parseAttendanceOpen(row.value),
      updatedAt: changedByAdmin ? row.updatedAt : null,
      updatedBy: changedByAdmin ? row.updatedBy : null,
    };
  } catch (err) {
    if (isUndefinedTable(err)) return { open: true, updatedAt: null, updatedBy: null };
    throw err;
  }
}

/**
 * For employee-facing reads (the attendance page and the verify step): if the setting
 * can't be read (e.g. a brief DB outage), assume open. Check-in stays authoritative —
 * insertSubmission re-checks inside its own transaction.
 */
export async function isAttendanceOpenOrDefault(context: string): Promise<boolean> {
  try {
    return (await getAttendanceStatus()).open;
  } catch (err) {
    console.error(`[${context}] could not read attendance status; assuming open`, err);
    return true;
  }
}

/**
 * Open or close attendance, with an audit log entry — in one transaction, under the
 * exclusive advisory lock (waits for in-flight check-ins; later ones then see the change).
 * Setting the value it already has changes nothing: no audit entry, "last changed" kept.
 * Returns whether the value actually changed.
 */
export async function setAttendanceOpen(open: boolean, actor: string): Promise<boolean> {
  return db().begin(async (sql) => {
    // Waits for in-flight check-ins, but at most 10 s: while this waits, new check-ins queue
    // behind it, so a stuck check-in must not be able to stall everyone (fails with 55P03).
    await sql`SET LOCAL lock_timeout = '10s'`;
    await sql`SELECT pg_advisory_xact_lock(${ATTENDANCE_LOCK_KEY}::bigint)`;
    const [current] = await sql<{ value: unknown }[]>`SELECT value FROM app_settings WHERE key = 'attendance_open'`;
    const currentOpen = current ? parseAttendanceOpen(current.value) : true;
    // A malformed stored value is always rewritten, even though it already reads as "closed"
    if (currentOpen === open && (!current || typeof current.value === "boolean")) return false;

    await sql`
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES ('attendance_open', ${sql.json(open)}, now(), ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await sql`
      INSERT INTO admin_audit_log (actor, action, details)
      VALUES (${actor}, ${open ? "attendance_opened" : "attendance_closed"}, ${sql.json({ open })})`;
    return true;
  }) as Promise<boolean>;
}

export interface DynamicGeofenceSettings {
  enabled: boolean;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface ActiveGeofenceConfig {
  enabled: boolean;
  target: { latitude: number; longitude: number };
  radiusMeters: number;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Reads dynamic geofence settings from app_settings (admin-customized).
 * Falls back to environment variables if unconfigured or during DB initialization.
 */
export async function getActiveGeofenceConfig(): Promise<ActiveGeofenceConfig> {
  const fallback = getGeofenceConfig();
  try {
    const [row] = await db()<{ value: unknown; updatedAt: Date; updatedBy: string }[]>`
      SELECT value, updated_at, updated_by FROM app_settings WHERE key = 'geofence_settings'`;
    if (!row || typeof row.value !== "object" || row.value === null) {
      return {
        enabled: true,
        target: fallback.target,
        radiusMeters: fallback.radiusMeters,
        updatedAt: null,
        updatedBy: null,
      };
    }
    const val = row.value as Record<string, unknown>;
    const enabled = typeof val.enabled === "boolean" ? val.enabled : true;
    const lat = typeof val.latitude === "number" && Number.isFinite(val.latitude) ? val.latitude : fallback.target.latitude;
    const lon = typeof val.longitude === "number" && Number.isFinite(val.longitude) ? val.longitude : fallback.target.longitude;
    const rad = typeof val.radiusMeters === "number" && val.radiusMeters > 0 ? val.radiusMeters : fallback.radiusMeters;
    return {
      enabled,
      target: { latitude: lat, longitude: lon },
      radiusMeters: rad,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  } catch (err) {
    if (isUndefinedTable(err)) {
      return {
        enabled: true,
        target: fallback.target,
        radiusMeters: fallback.radiusMeters,
        updatedAt: null,
        updatedBy: null,
      };
    }
    console.error("[settings] could not read geofence settings; using env fallback", err);
    return {
      enabled: true,
      target: fallback.target,
      radiusMeters: fallback.radiusMeters,
      updatedAt: null,
      updatedBy: null,
    };
  }
}

/**
 * Update dynamic geofence settings with audit logging.
 */
export async function setActiveGeofenceConfig(
  settings: DynamicGeofenceSettings,
  actor: string,
): Promise<ActiveGeofenceConfig> {
  const jsonVal = {
    enabled: Boolean(settings.enabled),
    latitude: Number(settings.latitude),
    longitude: Number(settings.longitude),
    radiusMeters: Number(settings.radiusMeters),
  };
  return db().begin(async (sql) => {
    await sql`
      INSERT INTO app_settings (key, value, updated_at, updated_by)
      VALUES ('geofence_settings', ${sql.json(jsonVal)}, now(), ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`;
    await sql`
      INSERT INTO admin_audit_log (actor, action, details)
      VALUES (${actor}, 'geofence_settings_updated', ${sql.json(jsonVal)})`;
    return {
      enabled: jsonVal.enabled,
      target: { latitude: jsonVal.latitude, longitude: jsonVal.longitude },
      radiusMeters: jsonVal.radiusMeters,
      updatedAt: new Date(),
      updatedBy: actor,
    };
  });
}
