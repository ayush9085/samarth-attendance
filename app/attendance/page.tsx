import type { Metadata } from "next";
import { AttendanceClosed } from "@/components/attendance/attendance-closed";
import { AttendanceFlow } from "@/components/attendance/attendance-flow";
import { getGeofenceConfig } from "@/lib/config";
import { isAttendanceOpenOrDefault } from "@/lib/db";

export const metadata: Metadata = {
  title: "SAMARTH INTERNSHIP 3.0 Ice Breaking Session Attendance Form",
  description: "Official location-verified attendance form for UPES SAMARTH Internship 3.0 Ice Breaking Session",
};

// Read env at request time so changing the workplace never requires a rebuild.
export const dynamic = "force-dynamic";

/**
 * Entry point opened by the workplace QR code. The page only knows the radius;
 * the workplace coordinates and every geofence decision stay on the server.
 */
export default async function AttendancePage() {
  const { radiusMeters } = getGeofenceConfig();
  // Admin switch (checked on every request). If the setting can't be read (e.g. a brief DB
  // outage), show the normal flow rather than an error page — the API enforces the switch.
  const open = await isAttendanceOpenOrDefault("attendance");

  return (
    <div className="min-h-full flex flex-col justify-between py-4 px-3 sm:py-8 sm:px-6">
      <main className="mx-auto w-full max-w-xl flex-1 flex flex-col">
        {/* Institutional Header */}
        <header className="mb-5 text-center">
          {/* Dual Logos Container - Prominent & Mobile-Friendly */}
          <div className="inline-flex items-center justify-center gap-5 sm:gap-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 sm:px-8 py-3.5 sm:py-4 shadow-xs mb-3.5">
            <div className="flex h-12 sm:h-14 items-center justify-center">
              <img src="/upes-logo.png" alt="UPES Logo" className="h-11 sm:h-13 w-auto object-contain" />
            </div>
            <div className="h-8 sm:h-10 w-px bg-slate-200 dark:bg-slate-700" />
            <div className="flex h-12 sm:h-14 items-center justify-center">
              <img src="/samarth-logo.png" alt="SAMARTH Logo" className="h-11 sm:h-13 w-auto object-contain" />
            </div>
          </div>

          {/* Heading */}
          <div className="space-y-1">
            <p className="text-[11px] sm:text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              UPES · Official Attendance Portal
            </p>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              SAMARTH INTERNSHIP 3.0
            </h1>
            <p className="text-xs sm:text-sm font-medium text-slate-700 dark:text-slate-300">
              Ice Breaking Session Attendance & Feedback
            </p>
          </div>
        </header>

        {open ? (
          <>
            <AttendanceFlow radiusMeters={radiusMeters} />
            <footer className="mt-8 text-center text-xs text-slate-500 dark:text-slate-400 space-y-1 pb-4">
              <p className="font-medium text-slate-600 dark:text-slate-400">
                UPES × SAMARTH Internship 3.0 · Campus Geofenced Attendance
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                Checked strictly within {radiusMeters} m of the event hall. No background tracking occurs.
              </p>
            </footer>
          </>
        ) : (
          <AttendanceClosed retryHref="/attendance" />
        )}
      </main>
    </div>
  );
}
