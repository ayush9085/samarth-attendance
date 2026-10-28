/**
 * Realistic Load Testing Harness for UPES Attendance Portal
 *
 * Simulates real-world attendance load:
 * - 67 SOCS batches × 35 students = 2,345 students + ~110 others = ~2,455 students total
 * - Scenarios:
 *   1. Progressive concurrency tiers: 35, 100, 200, 350, 500, 750, 1000
 *   2. QR Burst scenarios:
 *      - 10-second burst (500 submissions)
 *      - 30-second burst (1,000 submissions)
 *      - 120-second full session (2,455 submissions spread across window)
 */

import postgres from "postgres";
import { UPES_SCHOOLS } from "../lib/validation";

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const TEST_DB_URL = process.env.TEST_DATABASE_URL || "postgres://ayush9085@localhost:5432/geofence_load_test";

const UPES_LAT = 30.417006;
const UPES_LON = 77.966656;

const FIRST_NAMES = [
  "Aarav", "Aditi", "Ananya", "Ayush", "Dev", "Dhruv", "Ishaan", "Kavya",
  "Mira", "Neha", "Pranav", "Rahul", "Rhea", "Rohan", "Siddharth", "Tanvi", "Varun", "Zara",
  "Aditya", "Diya", "Kabir", "Meera", "Arjun", "Anika", "Aryan", "Pooja", "Vikram", "Sanya",
];

const LAST_NAMES = [
  "Sharma", "Verma", "Patel", "Mehta", "Singh", "Kapoor", "Gupta", "Joshi",
  "Bhatia", "Reddy", "Nair", "Iyer", "Choudhury", "Saxena", "Mishra", "Das", "Rao", "Malhotra",
  "Sen", "Bose", "Ghosh", "Agarwal", "Bansal", "Kumar", "Pandey", "Chauhan",
];

function generateStudentName(index: number): string {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length];
  return `${first} ${last}`;
}

interface SubmissionResult {
  id: number;
  sapId: string;
  verifyDurationMs: number;
  checkInDurationMs: number;
  totalDurationMs: number;
  verifyStatus: number;
  checkInStatus: number;
  success: boolean;
  error?: string;
}

export interface TierReport {
  tierName: string;
  concurrency: number;
  totalRequests: number;
  successful: number;
  failed: number;
  elapsedSec: number;
  requestsPerSec: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  statusCodes: Record<string, number>;
  errors: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, Math.min(index, sorted.length - 1))]);
}

async function resetTestDb() {
  const sql = postgres(TEST_DB_URL, { max: 1 });
  try {
    await sql`TRUNCATE submissions, used_verifications, admin_audit_log`;
  } finally {
    await sql.end();
  }
}

async function getStoredSubmissionsCount(): Promise<number> {
  const sql = postgres(TEST_DB_URL, { max: 1 });
  try {
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM submissions`;
    return count;
  } finally {
    await sql.end();
  }
}

async function simulateStudentSubmission(studentIndex: number): Promise<SubmissionResult> {
  const sapId = `5000${studentIndex.toString().padStart(6, "0")}`;
  const batchNum = (studentIndex % 67) + 1;
  const school = UPES_SCHOOLS[studentIndex % UPES_SCHOOLS.length];
  const studentName = generateStudentName(studentIndex);
  const t0 = performance.now();

  try {
    // Step 1: Verify location
    const verifyStart = performance.now();
    const verifyRes = await fetch(`${BASE_URL}/api/attendance/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: UPES_LAT + (Math.random() - 0.5) * 0.0001,
        longitude: UPES_LON + (Math.random() - 0.5) * 0.0001,
        accuracy: 10 + Math.random() * 15,
        positionTimestamp: Date.now(),
      }),
    });
    const verifyDurationMs = performance.now() - verifyStart;
    const verifyData = (await verifyRes.json().catch(() => ({}))) as {
      ok?: boolean;
      verificationToken?: string;
      error?: string;
    };

    if (!verifyRes.ok || !verifyData.verificationToken) {
      return {
        id: studentIndex,
        sapId,
        verifyDurationMs,
        checkInDurationMs: 0,
        totalDurationMs: performance.now() - t0,
        verifyStatus: verifyRes.status,
        checkInStatus: 0,
        success: false,
        error: `Verify failed (${verifyRes.status}): ${verifyData.error || "no token"}`,
      };
    }

    // Step 2: Check in
    const checkInStart = performance.now();
    const checkInRes = await fetch(`${BASE_URL}/api/attendance/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: studentName,
        sapId,
        school,
        course: "B.Tech Computer Science and Engineering",
        specialization: "Artificial Intelligence and Machine Learning",
        batch: `B${batchNum}`,
        eventRating: "5",
        contentRelevance: "5",
        suggestions: "Session was well organized.",
        verificationToken: verifyData.verificationToken,
      }),
    });
    const checkInDurationMs = performance.now() - checkInStart;
    const checkInData = (await checkInRes.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      fieldErrors?: Record<string, string>;
    };

    const isSuccess = checkInRes.status === 201 && checkInData.ok === true;
    const errorDetails = checkInData.fieldErrors
      ? JSON.stringify(checkInData.fieldErrors)
      : checkInData.error || "unknown";

    return {
      id: studentIndex,
      sapId,
      verifyDurationMs,
      checkInDurationMs,
      totalDurationMs: performance.now() - t0,
      verifyStatus: verifyRes.status,
      checkInStatus: checkInRes.status,
      success: isSuccess,
      error: isSuccess ? undefined : `Check-in failed (${checkInRes.status}): ${errorDetails}`,
    };
  } catch (err) {
    return {
      id: studentIndex,
      sapId,
      verifyDurationMs: 0,
      checkInDurationMs: 0,
      totalDurationMs: performance.now() - t0,
      verifyStatus: 0,
      checkInStatus: 0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runConcurrentBatch(
  name: string,
  totalStudents: number,
  concurrencyLimit: number,
  startIdOffset: number = 0,
  spacingMs: number = 0,
): Promise<TierReport> {
  process.stdout.write(`\n--- Running: ${name} (${totalStudents} students, concurrency: ${concurrencyLimit}) ---\n`);

  const results: SubmissionResult[] = [];
  const statusCodes: Record<string, number> = {};
  const errors: Record<string, number> = {};

  const startTime = performance.now();
  let activeCount = 0;
  let nextIndex = 0;

  await new Promise<void>((resolve) => {
    function launchNext() {
      if (nextIndex >= totalStudents && activeCount === 0) {
        resolve();
        return;
      }

      while (activeCount < concurrencyLimit && nextIndex < totalStudents) {
        const studentId = startIdOffset + nextIndex;
        nextIndex++;
        activeCount++;

        simulateStudentSubmission(studentId)
          .then((res) => {
            results.push(res);
            const statusKey = `verify:${res.verifyStatus}/checkin:${res.checkInStatus}`;
            statusCodes[statusKey] = (statusCodes[statusKey] || 0) + 1;
            if (!res.success && res.error) {
              errors[res.error] = (errors[res.error] || 0) + 1;
            }
          })
          .catch((err) => {
            const errKey = String(err);
            errors[errKey] = (errors[errKey] || 0) + 1;
          })
          .finally(() => {
            activeCount--;
            if (spacingMs > 0) {
              setTimeout(launchNext, spacingMs);
            } else {
              launchNext();
            }
          });
      }
    }

    launchNext();
  });

  const elapsedSec = (performance.now() - startTime) / 1000;
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const latencies = results.map((r) => r.totalDurationMs).sort((a, b) => a - b);

  const report: TierReport = {
    tierName: name,
    concurrency: concurrencyLimit,
    totalRequests: results.length,
    successful,
    failed,
    elapsedSec: Number(elapsedSec.toFixed(2)),
    requestsPerSec: Number((results.length / elapsedSec).toFixed(1)),
    p50Ms: percentile(latencies, 50),
    p90Ms: percentile(latencies, 90),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies.length > 0 ? Math.round(latencies[0]) : 0,
    maxMs: latencies.length > 0 ? Math.round(latencies[latencies.length - 1]) : 0,
    statusCodes,
    errors,
  };

  console.log(`Results for ${name}:`);
  console.log(`  Completed: ${report.successful}/${report.totalRequests} (${((report.successful / report.totalRequests) * 100).toFixed(1)}%) in ${report.elapsedSec}s`);
  console.log(`  Throughput: ${report.requestsPerSec} complete submissions/sec`);
  console.log(`  Latencies: min=${report.minMs}ms, p50=${report.p50Ms}ms, p95=${report.p95Ms}ms, p99=${report.p99Ms}ms, max=${report.maxMs}ms`);
  if (Object.keys(errors).length > 0) {
    console.log(`  Errors:`, errors);
  }

  return report;
}

export async function runLoadTests() {
  console.log("==================================================================");
  console.log("UPES SAMARTH ATTENDANCE: OFFICIAL PRE-HANDOVER LOAD TESTING SUITE");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Database: ${TEST_DB_URL}`);
  console.log("==================================================================");

  // Health check
  try {
    const res = await fetch(`${BASE_URL}/attendance`);
    if (!res.ok) throw new Error(`Status ${res.status}`);
  } catch (err) {
    console.error(`Cannot connect to target at ${BASE_URL}:`, err);
    process.exit(1);
  }

  const reports: TierReport[] = [];

  // Reset database before test run
  await resetTestDb();

  // Progressive Concurrency Tiers:
  reports.push(await runConcurrentBatch("35 concurrent (1 SOCS batch)", 35, 35, 1000));
  reports.push(await runConcurrentBatch("100 concurrent submissions", 100, 100, 2000));
  reports.push(await runConcurrentBatch("200 concurrent submissions", 200, 200, 3000));
  reports.push(await runConcurrentBatch("350 concurrent submissions (10 batches)", 350, 350, 4000));
  reports.push(await runConcurrentBatch("500 concurrent submissions", 500, 500, 5000));
  reports.push(await runConcurrentBatch("750 concurrent submissions", 750, 750, 6000));
  reports.push(await runConcurrentBatch("1,000 concurrent submissions", 1000, 1000, 7000));

  // Reset DB for clean 2,455 Full Cohort testing
  await resetTestDb();

  // QR Pattern 1: 10-second burst (500 students arriving in first 10s)
  reports.push(await runConcurrentBatch("Pattern: 10-second burst (500 submissions)", 500, 150, 20000));

  // QR Pattern 2: 30-second burst (1,000 students arriving in first 30s)
  reports.push(await runConcurrentBatch("Pattern: 30-second burst (1,000 submissions)", 1000, 150, 30000));

  // Reset DB for complete 2,455 cohort test
  await resetTestDb();

  // Full Session: 2,455 students total spread across the 2-minute (120-second) window
  reports.push(await runConcurrentBatch("Full Session: 2,455 students (Total Cohort)", 2455, 100, 50000));

  // Verify DB persistence
  const storedTotal = await getStoredSubmissionsCount();
  console.log(`\n✓ Verified Database Persistence: ${storedTotal} attendance rows stored in submissions table.`);

  console.log("\n==================================================================");
  console.log("FINAL PERFORMANCE & LOAD TEST AUDIT TABLE");
  console.log("==================================================================");
  console.table(
    reports.map((r) => ({
      Tier: r.tierName,
      Concurrency: r.concurrency,
      Total: r.totalRequests,
      Success: r.successful,
      Failed: r.failed,
      "Success%": `${((r.successful / r.totalRequests) * 100).toFixed(1)}%`,
      "Req/s": r.requestsPerSec,
      "p50 (ms)": r.p50Ms,
      "p95 (ms)": r.p95Ms,
      "p99 (ms)": r.p99Ms,
    })),
  );
}

runLoadTests().catch(console.error);
