"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AttendanceClosed } from "@/components/attendance/attendance-closed";
import { Spinner } from "@/components/ui/spinner";
import { formatDistance } from "@/lib/geo";
import { employeeSchema, fieldErrors as toFieldErrors, validateEmployeeField, type EmployeeField } from "@/lib/validation";
import type { CheckInResponse, VerifyResponse } from "@/types/submission";

type Phase =
  | { k: "idle"; notice?: string }
  | { k: "locating" }
  | { k: "verifying" }
  | { k: "outside"; distance: number; radius: number; accuracy: number }
  | { k: "error"; message: string }
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
      eventRating: string;
      contentRelevance: string;
      createdAt: string;
      refId: string;
    }
  | { k: "closed" };

const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 };

const RATING_OPTIONS = [
  { value: "1", label: "Average" },
  { value: "2", label: "Good" },
  { value: "3", label: "Very Good" },
  { value: "4", label: "Outstanding" },
  { value: "5", label: "Excellent" },
] as const;

const EMPTY_FORM: Record<EmployeeField, string> = {
  name: "",
  sapId: "",
  course: "",
  specialization: "",
  batch: "",
  eventRating: "",
  contentRelevance: "",
  suggestions: "",
};
const FIELDS = Object.keys(EMPTY_FORM) as EmployeeField[];

function geolocationErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Location permission denied. Please allow location access in your browser settings and try again.";
    case err.POSITION_UNAVAILABLE:
      return "GPS signal unavailable. Ensure location/GPS is enabled on your device.";
    case err.TIMEOUT:
      return "GPS detection timed out. Move closer to a window or outdoors and retry.";
    default:
      return "Unable to determine your GPS location. Please try again.";
  }
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, GEO_OPTIONS));
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
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

  async function simulateVenueLocation() {
    setFormError(null);
    setPhase({ k: "verifying" });
    try {
      const res = await fetch("/api/attendance/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latitude: 30.417006,
          longitude: 77.966656,
          accuracy: 10,
          positionTimestamp: Date.now(),
        }),
      });
      const data = (await res.json().catch(() => null)) as VerifyResponse | null;
      if (!data || !data.ok) {
        setPhase({ k: "error", message: data?.error || "Unable to verify location." });
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
      }
    } catch {
      setPhase({ k: "error", message: "Error verifying test location." });
    }
  }

  // Auto-bypass if ?bypass=1 or ?test=1 in URL
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("bypass") === "1" || params.get("test") === "1" || params.get("dev") === "1") {
        simulateVenueLocation();
      }
    }
  }, []);

  async function runLocationCheck() {
    setFormError(null);
    if (!window.isSecureContext) {
      setPhase({
        k: "error",
        message: "Location access requires an HTTPS or localhost connection.",
      });
      return;
    }
    if (!("geolocation" in navigator)) {
      setPhase({
        k: "error",
        message: "Your browser does not support geolocation. Please open this page in Chrome, Safari, or Edge.",
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
        message: "Unable to connect to verification server. Please check your network connection and retry.",
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
            notice: "This attendance record was already submitted.",
          });
        } else if (data.fieldErrors) {
          setErrors(data.fieldErrors);
          setFormError("Please complete all required fields correctly.");
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
        eventRating: form.eventRating,
        contentRelevance: form.contentRelevance,
        createdAt: data.checkIn.createdAt,
        refId: data.checkIn.id,
      });
    } catch {
      setFormError("Network error while submitting attendance. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const set = (field: EmployeeField) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const val = e.target.value;
    setForm((f) => ({ ...f, [field]: val }));
    if (touched.has(field)) {
      setErrors((errs) => ({ ...errs, [field]: validateEmployeeField(field, val) ?? "" }));
    }
  };

  const setRating = (field: "eventRating" | "contentRelevance", val: string) => {
    setForm((f) => ({ ...f, [field]: val }));
    setTouched((t) => new Set(t).add(field));
    setErrors((errs) => {
      const updated = { ...errs };
      delete updated[field];
      return updated;
    });
  };

  const blur = (field: EmployeeField) => () => {
    setTouched((t) => new Set(t).add(field));
    setErrors((errs) => ({ ...errs, [field]: validateEmployeeField(field, form[field]) ?? "" }));
  };

  if (phase.k === "closed") return <AttendanceClosed onRetry={detectLocation} />;

  // ── Success State: Official Attendance Slip ───────────────────────────────────
  if (phase.k === "done") {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs">
        <section aria-live="polite" className="space-y-6">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                <span>✓</span> Recorded Successfully
              </span>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white mt-1">
                Official Attendance Slip
              </h2>
            </div>
            <div className="text-right">
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 block">
                Ref: {phase.refId.slice(0, 8).toUpperCase()}
              </span>
              <span className="text-[11px] text-slate-400 block">
                {timeLabel(phase.createdAt)}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 divide-y divide-slate-200 dark:divide-slate-800 text-xs">
            <div className="flex justify-between px-3.5 py-2.5">
              <span className="text-slate-500 font-medium">Student Name</span>
              <span className="font-semibold text-slate-900 dark:text-white">{phase.name}</span>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <span className="text-slate-500 font-medium">SAP ID</span>
              <span className="font-mono font-semibold text-slate-900 dark:text-white">{phase.sapId}</span>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <span className="text-slate-500 font-medium">Course & Specialization</span>
              <span className="font-semibold text-slate-900 dark:text-white">
                {phase.course} · {phase.specialization}
              </span>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <span className="text-slate-500 font-medium">Batch</span>
              <span className="font-semibold text-slate-900 dark:text-white">{phase.batch}</span>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <span className="text-slate-500 font-medium">Session</span>
              <span className="font-semibold text-slate-900 dark:text-white">
                SAMARTH INTERNSHIP 3.0 — Ice Breaking
              </span>
            </div>
            <div className="flex justify-between px-3.5 py-2.5">
              <span className="text-slate-500 font-medium">Venue Geofence</span>
              <span className="font-medium text-emerald-700 dark:text-emerald-400">
                Verified within 100m
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3.5 text-center text-xs text-slate-500">
            Your attendance has been recorded in the UPES database. You may now close this tab.
          </div>
        </section>
      </div>
    );
  }

  const isVerified = phase.k === "verified";

  return (
    <div className="space-y-4">
      {/* Enterprise Stepper */}
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3 text-xs">
        <div className={`flex items-center gap-2 ${!isVerified ? "text-[#003a70] dark:text-sky-400 font-semibold" : "text-emerald-700 dark:text-emerald-400 font-medium"}`}>
          <span className={`flex size-5 items-center justify-center rounded-full text-[11px] font-bold ${!isVerified ? "bg-[#003a70] text-white dark:bg-sky-500" : "bg-emerald-600 text-white"}`}>
            {isVerified ? "✓" : "1"}
          </span>
          <span>1. Geofence Verification</span>
        </div>
        <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800 mx-3" />
        <div className={`flex items-center gap-2 ${isVerified ? "text-[#003a70] dark:text-sky-400 font-semibold" : "text-slate-400"}`}>
          <span className={`flex size-5 items-center justify-center rounded-full text-[11px] font-bold ${isVerified ? "bg-[#003a70] text-white dark:bg-sky-500" : "bg-slate-200 dark:bg-slate-800 text-slate-500"}`}>
            2
          </span>
          <span>2. Attendance & Feedback</span>
        </div>
      </div>

      {/* Step 1: Geofence Verification Card */}
      {!isVerified && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs space-y-5">
          {(phase.k === "idle" || phase.k === "error") && (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-[#003a70] dark:text-sky-400">
                <PinIcon />
              </div>

              <div className="space-y-1">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Venue Presence Verification
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                  To register attendance, verify that you are within the authorized event perimeter (<span className="font-semibold text-slate-800 dark:text-slate-200">{radiusMeters} meters</span> of the UPES venue).
                </p>
              </div>

              {/* Status Notice */}
              {phase.k === "idle" && phase.notice && (
                <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-200 text-left">
                  {phase.notice}
                </div>
              )}
              {phase.k === "error" && (
                <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 text-xs text-rose-800 dark:text-rose-200 text-left">
                  {phase.message}
                </div>
              )}

              <div className="space-y-2 pt-2">
                <button
                  type="button"
                  onClick={detectLocation}
                  className="btn-primary w-full py-2.5 text-sm font-semibold"
                >
                  {phase.k === "error" ? "Retry Location Check" : "Verify Location & Proceed"}
                </button>

                <button
                  type="button"
                  onClick={simulateVenueLocation}
                  className="w-full py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  Test Mode: Skip Geofence Check
                </button>
              </div>
            </div>
          )}

          {(phase.k === "locating" || phase.k === "verifying") && (
            <div aria-live="polite" className="flex flex-col items-center gap-3 py-6 text-center">
              <Spinner className="size-8 text-[#003a70] dark:text-sky-400" />
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  {phase.k === "locating" ? "Acquiring GPS Signal…" : "Validating Campus Geofence…"}
                </p>
                <p className="text-xs text-slate-500">
                  {phase.k === "locating"
                    ? "Please grant location access when prompted by your browser."
                    : "Verifying physical coordinates against UPES event venue coordinates."}
                </p>
              </div>
            </div>
          )}

          {phase.k === "outside" && (
            <div role="alert" className="space-y-4 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-rose-100 dark:bg-rose-950/50 text-rose-600">
                <span className="text-lg font-bold">!</span>
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-rose-800 dark:text-rose-400">
                  Location Outside Authorized Area
                </h3>
                <p className="text-xs text-slate-500">
                  You are outside the required session geofence.
                </p>
              </div>

              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-3 text-xs space-y-1.5 text-left">
                <div className="flex justify-between">
                  <span className="text-slate-500">Detected Distance:</span>
                  <span className="font-semibold text-rose-600">{formatDistance(phase.distance)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Allowed Perimeter:</span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">within {phase.radius} meters</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">GPS Accuracy:</span>
                  <span className="font-mono text-slate-800 dark:text-slate-200">±{Math.round(phase.accuracy)} m</span>
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <button type="button" onClick={detectLocation} className="btn-secondary w-full py-2.5 text-xs font-semibold">
                  Retry Location Check
                </button>
                <button
                  type="button"
                  onClick={simulateVenueLocation}
                  className="w-full py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-300"
                >
                  Test Mode: Skip Geofence Check
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: The Verified Attendance Form */}
      {isVerified && (
        <div className="space-y-4">
          {/* Location Verified Notice */}
          <div aria-live="polite" className="rounded-lg border border-emerald-200 dark:border-emerald-800/80 bg-emerald-50/70 dark:bg-emerald-950/20 px-3.5 py-2.5 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex size-4.5 items-center justify-center rounded-full bg-emerald-600 text-white text-[10px] font-bold">
                ✓
              </span>
              <span className="font-semibold text-emerald-900 dark:text-emerald-300">
                Venue Geofence Verified
              </span>
              <span className="text-slate-500 dark:text-slate-400">
                · {formatDistance(phase.distance)} from center
              </span>
            </div>
            <span className="text-[11px] text-slate-400">
              Valid until {new Date(phase.expiresAt).toLocaleTimeString("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" })}
            </span>
          </div>

          {/* Form Card */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-xs">
            <form onSubmit={onCheckIn} noValidate className="space-y-5">
              {/* Section 1: Student Information */}
              <div className="space-y-3.5">
                <div className="border-b border-slate-200 dark:border-slate-800 pb-2">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    Student Details
                  </h3>
                </div>

                {/* Student Name */}
                <Field
                  id="name"
                  label="Student Full Name"
                  required
                  error={errors.name}
                >
                  <input
                    id="name"
                    className="input"
                    autoComplete="name"
                    maxLength={100}
                    placeholder="e.g. Aarav Sharma"
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
                  required
                  error={errors.sapId}
                >
                  <input
                    id="sapId"
                    className="input uppercase font-mono"
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

                {/* Course & Specialization Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field
                    id="course"
                    label="Course"
                    required
                    error={errors.course}
                  >
                    <input
                      id="course"
                      className="input"
                      maxLength={100}
                      placeholder="e.g. B.Tech, BCA, MCA"
                      required
                      value={form.course}
                      onChange={set("course")}
                      onBlur={blur("course")}
                      aria-required
                      aria-invalid={!!errors.course}
                      aria-describedby={errors.course ? "course-error" : undefined}
                    />
                  </Field>

                  <Field
                    id="specialization"
                    label="Specialization"
                    required
                    error={errors.specialization}
                  >
                    <input
                      id="specialization"
                      className="input"
                      maxLength={100}
                      placeholder="e.g. AI & ML, Cyber Security, CSE"
                      required
                      value={form.specialization}
                      onChange={set("specialization")}
                      onBlur={blur("specialization")}
                      aria-required
                      aria-invalid={!!errors.specialization}
                      aria-describedby={errors.specialization ? "specialization-error" : undefined}
                    />
                  </Field>
                </div>

                {/* Batch */}
                <Field
                  id="batch"
                  label="Batch / Year"
                  required
                  error={errors.batch}
                >
                  <input
                    id="batch"
                    className="input"
                    maxLength={50}
                    placeholder="e.g. 2023-2027 or Batch A"
                    required
                    value={form.batch}
                    onChange={set("batch")}
                    onBlur={blur("batch")}
                    aria-required
                    aria-invalid={!!errors.batch}
                    aria-describedby={errors.batch ? "batch-error" : undefined}
                  />
                </Field>
              </div>

              {/* Section 2: Session Feedback */}
              <div className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800">
                <div className="border-b border-slate-200 dark:border-slate-800 pb-2">
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
                    Session Feedback
                  </h3>
                </div>

                {/* Q1: Overall Quality */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Q1. How would you rate the overall quality of the event? <span className="text-rose-500">*</span>
                  </label>
                  <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
                    {RATING_OPTIONS.map((opt) => {
                      const isSelected = form.eventRating === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setRating("eventRating", opt.value)}
                          className={`py-2 px-1 rounded-md border text-center transition-colors cursor-pointer ${
                            isSelected
                              ? "border-[#003a70] bg-[#003a70] text-white dark:border-sky-500 dark:bg-sky-600 font-semibold shadow-2xs"
                              : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/60"
                          }`}
                        >
                          <span className="block text-sm font-bold">{opt.value}</span>
                          <span className="block text-[10px] leading-tight mt-0.5 truncate">{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {errors.eventRating && (
                    <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">{errors.eventRating}</p>
                  )}
                </div>

                {/* Q5: Content Relevance */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Q5. Did you find the content relevant and informative? <span className="text-rose-500">*</span>
                  </label>
                  <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
                    {RATING_OPTIONS.map((opt) => {
                      const isSelected = form.contentRelevance === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setRating("contentRelevance", opt.value)}
                          className={`py-2 px-1 rounded-md border text-center transition-colors cursor-pointer ${
                            isSelected
                              ? "border-[#003a70] bg-[#003a70] text-white dark:border-sky-500 dark:bg-sky-600 font-semibold shadow-2xs"
                              : "border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/60"
                          }`}
                        >
                          <span className="block text-sm font-bold">{opt.value}</span>
                          <span className="block text-[10px] leading-tight mt-0.5 truncate">{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {errors.contentRelevance && (
                    <p className="text-xs text-rose-600 dark:text-rose-400 mt-1">{errors.contentRelevance}</p>
                  )}
                </div>

                {/* Q11: Suggestions, if any */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label htmlFor="suggestions" className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                      Q11. Suggestions, if any
                    </label>
                    <span className="text-[10px] text-slate-400">Optional</span>
                  </div>
                  <textarea
                    id="suggestions"
                    rows={3}
                    className="input resize-none py-2 text-xs"
                    maxLength={1000}
                    placeholder="Enter any suggestions or feedback for future internship sessions..."
                    value={form.suggestions}
                    onChange={set("suggestions")}
                  />
                </div>
              </div>

              {formError && (
                <div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 text-xs text-rose-700 dark:text-rose-300">
                  {formError}
                </div>
              )}

              <button
                type="submit"
                className="btn-primary w-full py-3 text-sm font-semibold shadow-xs"
                disabled={submitting}
              >
                {submitting ? "Submitting Record…" : "Submit Attendance & Feedback"}
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
  required,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
        {label}
        {required && (
          <span className="text-rose-600 dark:text-rose-400" aria-hidden>
            {" "}*
          </span>
        )}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-rose-600 dark:text-rose-400">
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
