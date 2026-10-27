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
    <div className="min-h-full flex flex-col justify-between py-6 px-4 sm:px-6 sm:py-10">
      <main className="mx-auto w-full max-w-xl flex-1 flex flex-col">
        {/* Institutional Header Banner */}
        <header className="mb-6 space-y-4 text-center">
          {/* Dual Logos Card */}
          <div className="inline-flex mx-auto items-center justify-center gap-3 sm:gap-4 rounded-2xl border border-border/80 bg-white/95 dark:bg-slate-900/90 px-4 py-2.5 shadow-sm backdrop-blur-md">
            <div className="flex h-11 items-center justify-center">
              <img src="/upes-logo.png" alt="UPES Logo" className="h-9 w-auto object-contain" />
            </div>
            <div className="h-6 w-px bg-slate-200 dark:bg-slate-700" />
            <div className="flex h-11 items-center justify-center">
              <img src="/samarth-logo.png" alt="SAMARTH Logo" className="h-8 w-auto object-contain" />
            </div>
          </div>

          {/* Event Badge & Title */}
          <div className="space-y-1.5">
            <div className="inline-flex items-center gap-2 rounded-full bg-sky-50 dark:bg-sky-950/60 border border-sky-200/80 dark:border-sky-800/80 px-3.5 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300 shadow-2xs">
              <span className="size-2 rounded-full bg-emerald-500 animate-ping" />
              <span>UPES · Official Attendance Portal</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
              SAMARTH INTERNSHIP 3.0
            </h1>
            <p className="text-base sm:text-lg font-semibold text-sky-800 dark:text-sky-300">
              Ice Breaking Session Attendance Form
            </p>
            {open && (
              <p className="text-xs sm:text-sm text-muted max-w-md mx-auto">
                Please verify your campus GPS location to access and submit the attendance form.
              </p>
            )}
          </div>

          {/* Tri-color Brand Ribbon */}
          <div className="h-1.5 w-full rounded-full brand-stripe shadow-xs opacity-90 max-w-md mx-auto" />
        </header>

        {open ? (
          <>
            <AttendanceFlow radiusMeters={radiusMeters} />
            <footer className="mt-8 text-center text-xs text-muted space-y-1 pb-4">
              <p className="font-medium text-slate-700 dark:text-slate-400">
                UPES × SAMARTH Internship 3.0 · Campus Geofenced Verification
              </p>
              <p className="text-[11px] text-muted">
                Your location is checked once strictly within {radiusMeters} m of the event hall. No tracking occurs after check-in.
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
