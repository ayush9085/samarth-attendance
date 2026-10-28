import type { Metadata } from "next";
import { AttendanceClosed } from "@/components/attendance/attendance-closed";
import { AttendanceFlow } from "@/components/attendance/attendance-flow";
import { getActiveGeofenceConfig, isAttendanceOpenOrDefault } from "@/lib/db";

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
  const geofence = await getActiveGeofenceConfig();
  // Admin switch (checked on every request). If the setting can't be read (e.g. a brief DB
  // outage), show the normal flow rather than an error page — the API enforces the switch.
  const open = await isAttendanceOpenOrDefault("attendance");

  return (
    <div className="min-h-full flex flex-col justify-between py-4 px-3 sm:py-8 sm:px-6">
      <main className="mx-auto w-full max-w-xl flex-1 flex flex-col">
        {/* Institutional Header */}
        <header className="mb-5 text-center">
          {/* Dual Logos Container - Prominent & Mobile-Optimized */}
          <div className="inline-flex items-center justify-center gap-3.5 sm:gap-7 rounded-2xl border border-slate-200/90 bg-white px-4 sm:px-7 py-3 sm:py-4 shadow-xs mb-3.5 max-w-full">
            <div className="flex items-center justify-center">
              <img
                src="/upes-logo.png"
                alt="UPES - University of Petroleum and Energy Studies"
                className="h-9 xs:h-10 sm:h-12 w-auto max-w-[130px] sm:max-w-[175px] object-contain"
                loading="eager"
              />
            </div>
            <div className="h-8 sm:h-10 w-px bg-slate-200 shrink-0" />
            <div className="flex items-center justify-center">
              <img
                src="/samarth-logo.png"
                alt="SAMARTH Internship 3.0"
                className="h-9 xs:h-10 sm:h-12 w-auto max-w-[135px] sm:max-w-[180px] object-contain"
                loading="eager"
              />
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
            <AttendanceFlow radiusMeters={geofence.radiusMeters} geofenceEnabled={geofence.enabled} />
            <footer className="mt-8 text-center text-xs text-slate-500 dark:text-slate-400 space-y-1 pb-4">
              <p className="font-medium text-slate-600 dark:text-slate-400">
                UPES × SAMARTH Internship 3.0 · Campus Attendance
              </p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {geofence.enabled
                  ? `Checked strictly within ${geofence.radiusMeters} m of the event hall. No background tracking occurs.`
                  : "Direct check-in mode active. No GPS verification required."}
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
