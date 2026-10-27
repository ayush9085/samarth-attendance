"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { AttendanceClosed } from "@/components/attendance/attendance-closed";
import { Spinner } from "@/components/ui/spinner";
import { formatDistance } from "@/lib/geo";
import { employeeSchema, fieldErrors as toFieldErrors, validateEmployeeField, type EmployeeField } from "@/lib/validation";
import type { CheckInResponse, VerifyResponse } from "@/types/submission";

type Phase =
  | { k: "idle"; notice?: string }
  | { k: "locating" }
  | { k: "verifying" }
  | { k: "error"; message: string }
  | { k: "outside"; distance: number; radius: number; accuracy: number }
  | {
      k: "verified";
      distance: number;
      radius: number;
      accuracy: number;
      lowAccuracy: boolean;
      token: string;
      expiresAt: string;
    }
  | {
      k: "done";
      name: string;
      sapId: string;
      course: string;
      specialization: string;
      batch: string;
      createdAt: string;
      refId: string;
    }
  | { k: "closed" };

const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };

const EMPTY_FORM: Record<EmployeeField, string> = { name: "", sapId: "", course: "", specialization: "", batch: "" };
const FIELDS = Object.keys(EMPTY_FORM) as EmployeeField[];

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission denied. Please allow location access for this site in your browser settings (tap the lock/ⓘ icon next to URL) and try again.";
    case err.POSITION_UNAVAILABLE:
      return "GPS signal unavailable. Ensure location/GPS services are turned on on your device and try again.";
    case err.TIMEOUT:
      return "GPS detection timed out. Move closer to a window or outdoors and try again.";
    default:
      return "Unable to determine your GPS location. Please try again.";
  }
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTIONS));
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function AttendanceFlow({ radiusMeters }: { radiusMeters: number }) {
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [form, setForm] = useState<Record<EmployeeField, string>>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState<Set<EmployeeField>>(new Set());

  const detecting = useRef(false);

  async function detectLocation() {
    if (detecting.current) return;
    detecting.current = true;
    try {
      await runLocationCheck();
    } finally {
      detecting.current = false;
    }
  }

  async function runLocationCheck() {
    setFormError(null);
    if (!window.isSecureContext) {
      setPhase({
        k: "error",
        message: "Location is only available over a secure (HTTPS or localhost) connection. Please check your URL.",
      });
      return;
    }
    if (!("geolocation" in navigator)) {
      setPhase({
        k: "error",
        message: "Your browser does not support location services. Please open in Chrome, Safari, Firefox, or Edge.",
      });
      return;
    }

    setPhase({ k: "locating" });
    let pos: GeolocationPosition;
    try {
      pos = await getPosition();
    } catch (err) {
      setPhase({ k: "error", message: geolocationErrorMessage(err as GeolocationPositionError) });
      return;
    }

    const { latitude, longitude, accuracy } = pos.coords;
    if (![latitude, longitude, accuracy].every(Number.isFinite)) {
      setPhase({ k: "error", message: "Your device reported invalid GPS coordinates. Please try again." });
      return;
    }

    setPhase({ k: "verifying" });
    try {
      const res = await fetch("/api/attendance/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latitude, longitude, accuracy, positionTimestamp: Math.round(pos.timestamp) }),
      });
      const data = (await res.json().catch(() => null)) as VerifyResponse | null;
      if (!data) throw new Error("bad response");
      if (!data.ok) {
        setPhase(data.code === "ATTENDANCE_CLOSED" ? { k: "closed" } : { k: "error", message: data.error });
        return;
      }
      if (data.status === "WITHIN_RANGE" && data.verificationToken && data.expiresAt) {
        setPhase({
          k: "verified",
          distance: data.distanceMeters,
          radius: data.radiusMeters,
          accuracy: data.accuracyMeters,
          lowAccuracy: data.lowAccuracy,
          token: data.verificationToken,
          expiresAt: data.expiresAt,
        });
      } else {
        setPhase({
          k: "outside",
          distance: data.distanceMeters,
          radius: data.radiusMeters,
          accuracy: data.accuracyMeters,
        });
      }
    } catch {
      setPhase({
        k: "error",
        message: "Unable to connect to the attendance verification server. Check your internet connection and try again.",
      });
    }
  }

  async function onCheckIn(e: FormEvent) {
    e.preventDefault();
    if (phase.k !== "verified" || submitting) return;
    setFormError(null);
    setTouched(new Set(FIELDS));

    const parsed = employeeSchema.safeParse(form);
    if (!parsed.success) {
      setErrors(toFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      const res = await fetch("/api/attendance/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed.data, verificationToken: phase.token }),
      });
      const data = (await res.json().catch(() => null)) as CheckInResponse | null;
      if (!data) throw new Error("bad response");
      if (!data.ok) {
        if (data.code === "ATTENDANCE_CLOSED") {
          setPhase({ k: "closed" });
        } else if (data.code === "VERIFICATION_REQUIRED" || data.code === "OUTSIDE_RANGE") {
          setPhase({
            k: "idle",
            notice: data.error || "Location verification expired. Please verify your location again.",
          });
        } else if (data.code === "ALREADY_USED") {
          setPhase({
            k: "idle",
            notice: "This check-in was already processed. Verify location again if you need to re-submit.",
          });
        } else if (data.fieldErrors) {
          setErrors(data.fieldErrors);
          setFormError("Please correct the highlighted fields below.");
        } else {
          setFormError(data.error);
        }
        return;
      }

      setPhase({
        k: "done",
        name: data.checkIn.name,
        sapId: form.sapId,
        course: form.course,
        specialization: form.specialization,
        batch: form.batch,
        createdAt: data.checkIn.createdAt,
        refId: data.checkIn.id,
      });
    } catch {
      setFormError("Connection error while submitting attendance. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const set = (field: EmployeeField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
    if (touched.has(field)) {
      setErrors((errs) => ({ ...errs, [field]: validateEmployeeField(field, val) ?? "" }));
    }
  };

  const blur = (field: EmployeeField) => () => {
    setTouched((t) => new Set(t).add(field));
    setErrors((errs) => ({ ...errs, [field]: validateEmployeeField(field, form[field]) ?? "" }));
  };

  if (phase.k === "closed") return <AttendanceClosed onRetry={detectLocation} />;

  // ── Success State ───────────────────────────────────────────────────────────
  if (phase.k === "done") {
    return (
      <div className="relative overflow-hidden rounded-3xl border border-emerald-500/30 bg-surface p-6 sm:p-8 shadow-xl backdrop-blur-md">
        <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500" />
        
        <section aria-live="polite" className="space-y-6 text-center">
          <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 ring-8 ring-emerald-500/5">
            <svg viewBox="0 0 24 24" className="size-10" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>

          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Verified & Recorded
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              Attendance Submitted!
            </h2>
            <p className="mt-1 text-sm text-muted">
              SAMARTH INTERNSHIP 3.0 · Ice Breaking Session
            </p>
          </div>

          {/* Student Receipt Card */}
          <div className="rounded-2xl border border-border/80 bg-slate-50/70 dark:bg-slate-900/60 p-4 sm:p-5 text-left text-sm space-y-3">
            <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Student Name</span>
              <span className="font-bold text-slate-900 dark:text-white">{phase.name}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">SAP ID</span>
              <span className="font-mono font-bold text-sky-700 dark:text-sky-300">{phase.sapId}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Course & Spec.</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{phase.course} · {phase.specialization}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border/60 pb-2.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Batch</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">{phase.batch}</span>
            </div>
            <div className="flex items-center justify-between pt-0.5">
              <span className="text-xs font-medium uppercase tracking-wider text-muted">Check-In Time</span>
              <span className="tabular font-medium text-slate-800 dark:text-slate-200">{timeLabel(phase.createdAt)}</span>
            </div>
          </div>

          <p className="text-xs text-muted">
            Ref ID: <span className="font-mono text-slate-700 dark:text-slate-300">{phase.refId.slice(0, 8)}...</span> · You may now close this page.
          </p>
        </section>
      </div>
    );
  }

  const isVerified = phase.k === "verified";

  return (
    <div className="space-y-5">
      {/* Step Tracker */}
      <div className="grid grid-cols-2 gap-2 text-xs font-semibold">
        <div
          className={`flex items-center gap-2 rounded-xl border p-2.5 transition-all ${
            isVerified
              ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
              : "border-sky-500/50 bg-sky-500/10 text-sky-800 dark:text-sky-300 ring-2 ring-sky-500/15"
          }`}
        >
          <div
            className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${
              isVerified ? "bg-emerald-500 text-white" : "bg-sky-600 text-white"
            }`}
          >
            {isVerified ? "✓" : "1"}
          </div>
          <div className="min-w-0">
            <div className="truncate font-bold">Step 1</div>
            <div className="text-[11px] font-normal text-muted truncate">Campus Geofence</div>
          </div>
        </div>

        <div
          className={`flex items-center gap-2 rounded-xl border p-2.5 transition-all ${
            isVerified
              ? "border-sky-500/50 bg-sky-500/10 text-sky-800 dark:text-sky-300 ring-2 ring-sky-500/15"
              : "border-border/70 bg-surface/50 text-muted opacity-60"
          }`}
        >
          <div
            className={`flex size-6 items-center justify-center rounded-full text-xs font-bold ${
              isVerified ? "bg-sky-600 text-white" : "bg-slate-200 dark:bg-slate-800 text-slate-600"
            }`}
          >
            2
          </div>
          <div className="min-w-0">
            <div className="truncate font-bold">Step 2</div>
            <div className="text-[11px] font-normal text-muted truncate">Attendance Form</div>
          </div>
        </div>
      </div>

      {/* Step 1: Geofence Verification Card */}
      {!isVerified && (
        <div className="relative overflow-hidden rounded-3xl border border-border/90 bg-surface/95 p-6 sm:p-8 shadow-lg backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-1.5 brand-stripe opacity-90" />

          {(phase.k === "idle" || phase.k === "error") && (
            <div className="space-y-6 text-center">
              {/* Radar Icon with animated ripples */}
              <div className="relative mx-auto flex size-20 items-center justify-center">
                <span className="absolute inset-0 size-full animate-ping rounded-full bg-sky-400/20" />
                <span className="absolute inset-2 size-16 rounded-full bg-sky-500/15" />
                <div className="relative flex size-12 items-center justify-center rounded-full bg-gradient-to-tr from-[#005ea6] to-[#0284c7] text-white shadow-md">
                  <PinIcon />
                </div>
              </div>

              <div>
                <h3 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                  Location Check Required
                </h3>
                <p className="mt-1 text-sm text-muted max-w-sm mx-auto">
                  To prevent proxy attendance, verify you are within <span className="font-semibold text-slate-900 dark:text-white">{radiusMeters} meters</span> of the session venue.
                </p>
              </div>

              {/* Status / Notice */}
              {phase.k === "idle" && phase.notice && (
                <div role="status" className="rounded-xl border border-amber-300/60 bg-amber-500/10 p-3.5 text-xs text-amber-800 dark:text-amber-200">
                  {phase.notice}
                </div>
              )}
              {phase.k === "error" && (
                <div role="alert" className="rounded-xl border border-rose-300/60 bg-rose-500/10 p-3.5 text-xs text-rose-800 dark:text-rose-200">
                  {phase.message}
                </div>
              )}

              {/* Perks / Points */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-left text-xs text-slate-600 dark:text-slate-400 pt-1">
                <div className="rounded-xl border border-border/70 bg-slate-50/60 dark:bg-slate-900/40 p-2.5">
                  <div className="font-semibold text-slate-900 dark:text-white">📍 100m Geofence</div>
                  <div className="text-[11px] text-muted mt-0.5">Campus hall boundary</div>
                </div>
                <div className="rounded-xl border border-border/70 bg-slate-50/60 dark:bg-slate-900/40 p-2.5">
                  <div className="font-semibold text-slate-900 dark:text-white">🔒 1-Tap Secure</div>
                  <div className="text-[11px] text-muted mt-0.5">Read once; zero tracking</div>
                </div>
                <div className="rounded-xl border border-border/70 bg-slate-50/60 dark:bg-slate-900/40 p-2.5">
                  <div className="font-semibold text-slate-900 dark:text-white">⚡ Instant Unlock</div>
                  <div className="text-[11px] text-muted mt-0.5">Access form immediately</div>
                </div>
              </div>

              <button
                type="button"
                onClick={detectLocation}
                className="btn-primary w-full py-3.5 text-base shadow-md font-bold"
              >
                <PinIcon /> {phase.k === "error" ? "Retry Location Check" : "Detect My Location & Unlock Form"}
              </button>
            </div>
          )}

          {(phase.k === "locating" || phase.k === "verifying") && (
            <div aria-live="polite" className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="relative">
                <Spinner className="size-12 border-4 border-sky-600 dark:border-sky-400" />
              </div>
              <div className="space-y-1">
                <p className="text-lg font-bold text-slate-900 dark:text-white">
                  {phase.k === "locating" ? "Acquiring GPS Signal…" : "Verifying with Campus Geofence…"}
                </p>
                <p className="text-xs text-muted max-w-xs mx-auto">
                  {phase.k === "locating"
                    ? "Please tap “Allow” if your browser asks for location permission."
                    : "Validating physical coordinates against UPES session hall coordinates."}
                </p>
              </div>
            </div>
          )}

          {phase.k === "outside" && (
            <div role="alert" className="space-y-4 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-rose-500/10 text-rose-600">
                <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path strokeLinecap="round" d="m15 9-6 6m0-6 6 6" />
                </svg>
              </div>
              <div>
                <h3 className="text-lg font-bold text-rose-700 dark:text-rose-400">
                  Location Verification Failed
                </h3>
                <p className="mt-1 text-xs text-muted">
                  You are outside the authorized session area.
                </p>
              </div>

              <div className="rounded-2xl border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/20 p-4 text-xs space-y-2 text-left">
                <div className="flex justify-between">
                  <span className="text-muted">Detected Distance:</span>
                  <span className="font-bold text-rose-600">{formatDistance(phase.distance)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Required Radius:</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">within {phase.radius} meters</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">GPS Accuracy:</span>
                  <span className="font-mono text-slate-800 dark:text-slate-200">±{Math.round(phase.accuracy)} m</span>
                </div>
              </div>

              <p className="text-xs text-muted">
                Make sure you are at the UPES event venue and your GPS accuracy is good.
              </p>

              <button type="button" onClick={detectLocation} className="btn-secondary w-full py-3 font-semibold">
                <PinIcon /> Try Detecting Location Again
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 2: The Verified Attendance Form */}
      {isVerified && (
        <div className="space-y-4">
          {/* Geofence Verified Banner */}
          <div aria-live="polite" className="relative overflow-hidden rounded-2xl border border-emerald-500/40 bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-sky-500/10 p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-xs">
                ✓
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-bold text-emerald-800 dark:text-emerald-300 text-sm">
                    Location Verified Successfully
                  </h4>
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-300">
                    Within Geofence
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                  Distance: <span className="font-semibold text-slate-900 dark:text-white">{formatDistance(phase.distance)}</span> · GPS accuracy ±{Math.round(phase.accuracy)} m
                </p>
                <p className="mt-1 text-[11px] text-muted">
                  Expires at {new Date(phase.expiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}. Please submit the form before expiry.
                </p>
              </div>
            </div>
          </div>

          {/* Form Card */}
          <div className="relative overflow-hidden rounded-3xl border border-border/90 bg-surface/95 p-6 sm:p-8 shadow-xl backdrop-blur-md">
            <div className="absolute inset-x-0 top-0 h-1.5 brand-stripe" />

            <form onSubmit={onCheckIn} noValidate className="space-y-4">
              <div className="border-b border-border/60 pb-3">
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  Student Attendance Form
                </h3>
                <p className="text-xs text-muted mt-0.5">
                  Enter your official UPES enrollment details to register your attendance.
                </p>
              </div>

              {/* Student Name */}
              <Field
                id="name"
                label="Student Name"
                icon={<UserIcon />}
                required
                error={errors.name}
              >
                <input
                  id="name"
                  className="input pl-10"
                  autoComplete="name"
                  maxLength={100}
                  placeholder="e.g. Rahul Sharma"
                  required
                  value={form.name}
                  onChange={set("name")}
                  onBlur={blur("name")}
                  aria-required
                  aria-invalid={!!errors.name}
                  aria-describedby={errors.name ? "name-error" : undefined}
                />
              </Field>

              {/* SAP ID */}
              <Field
                id="sapId"
                label="SAP ID"
                icon={<IdIcon />}
                required
                error={errors.sapId}
              >
                <input
                  id="sapId"
                  className="input pl-10 uppercase"
                  maxLength={50}
                  placeholder="e.g. 500123456"
                  required
                  value={form.sapId}
                  onChange={set("sapId")}
                  onBlur={blur("sapId")}
                  aria-required
                  aria-invalid={!!errors.sapId}
                  aria-describedby={errors.sapId ? "sapId-error" : undefined}
                />
              </Field>

              {/* Course */}
              <Field
                id="course"
                label="Course"
                icon={<GraduationIcon />}
                required
                error={errors.course}
              >
                <input
                  id="course"
                  className="input pl-10"
                  maxLength={100}
                  placeholder="e.g. B.Tech, BCA, MCA, MBA"
                  required
                  value={form.course}
                  onChange={set("course")}
                  onBlur={blur("course")}
                  aria-required
                  aria-invalid={!!errors.course}
                  aria-describedby={errors.course ? "course-error" : undefined}
                />
              </Field>

              {/* Specialization */}
              <Field
                id="specialization"
                label="Specialization"
                icon={<BranchIcon />}
                required
                error={errors.specialization}
              >
                <input
                  id="specialization"
                  className="input pl-10"
                  maxLength={100}
                  placeholder="e.g. Computer Science, AI & ML, Cyber Security"
                  required
                  value={form.specialization}
                  onChange={set("specialization")}
                  onBlur={blur("specialization")}
                  aria-required
                  aria-invalid={!!errors.specialization}
                  aria-describedby={errors.specialization ? "specialization-error" : undefined}
                />
              </Field>

              {/* Batch */}
              <Field
                id="batch"
                label="Batch"
                icon={<CalendarIcon />}
                required
                error={errors.batch}
              >
                <input
                  id="batch"
                  className="input pl-10"
                  maxLength={50}
                  placeholder="e.g. 2024-2028 or Batch A"
                  required
                  value={form.batch}
                  onChange={set("batch")}
                  onBlur={blur("batch")}
                  aria-required
                  aria-invalid={!!errors.batch}
                  aria-describedby={errors.batch ? "batch-error" : undefined}
                />
              </Field>

              {formError && (
                <div role="alert" className="rounded-xl border border-rose-300 bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-300">
                  {formError}
                </div>
              )}

              <button
                type="submit"
                className="btn-primary w-full py-3.5 text-base font-bold shadow-lg shadow-sky-950/15"
                disabled={submitting}
              >
                {submitting ? "Recording Attendance…" : "Confirm & Submit Attendance ✓"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  icon,
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  icon?: ReactNode;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-semibold text-slate-800 dark:text-slate-200">
        {label}
        {required && (
          <span className="text-bad" aria-hidden>
            {" "}*
          </span>
        )}
      </label>
      <div className="relative">
        {icon && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted">
            {icon}
          </div>
        )}
        {children}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M12 21s-7-6.2-7-12a7 7 0 1 1 14 0c0 5.8-7 12-7 12Z" />
      <circle cx="12" cy="9" r="2.5" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
    </svg>
  );
}

function IdIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <circle cx="8" cy="11" r="2" />
      <path strokeLinecap="round" d="M13 10h4m-4 3h3" />
    </svg>
  );
}

function GraduationIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12a3 3 0 0 0 3 3h9M6 9h9a3 3 0 0 1 3 3v6" />
      <circle cx="6" cy="3" r="2" />
      <circle cx="18" cy="18" r="2" />
      <circle cx="18" cy="9" r="2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path strokeLinecap="round" d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}
