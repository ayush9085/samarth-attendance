"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateGeofenceSettingsAction } from "@/app/admin/actions";
import { Spinner } from "@/components/ui/spinner";
import type { ActiveGeofenceConfig } from "@/lib/db";

interface Props {
  initialConfig: ActiveGeofenceConfig;
}

const UPES_DEFAULT = {
  latitude: 30.417006,
  longitude: 77.966656,
  radiusMeters: 100,
};

export function GeofenceSettingsCard({ initialConfig }: Props) {
  const router = useRouter();
  const [config, setConfig] = useState(initialConfig);
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [latitude, setLatitude] = useState(String(initialConfig.target.latitude));
  const [longitude, setLongitude] = useState(String(initialConfig.target.longitude));
  const [radiusMeters, setRadiusMeters] = useState(String(initialConfig.radiusMeters));

  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [detectingLocation, setDetectingLocation] = useState(false);

  function handleUseMyLocation() {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser.");
      return;
    }
    setDetectingLocation(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDetectingLocation(false);
        setLatitude(pos.coords.latitude.toFixed(6));
        setLongitude(pos.coords.longitude.toFixed(6));
        setSuccess("Populated with your current GPS coordinates. Click 'Save Geofence Settings' to apply.");
      },
      (err) => {
        setDetectingLocation(false);
        setError(`Could not acquire your GPS position: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function handleResetDefault() {
    setLatitude(String(UPES_DEFAULT.latitude));
    setLongitude(String(UPES_DEFAULT.longitude));
    setRadiusMeters(String(UPES_DEFAULT.radiusMeters));
    setSuccess("Reset fields to official UPES venue coordinates. Click 'Save Geofence Settings' to apply.");
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const latNum = parseFloat(latitude);
    const lonNum = parseFloat(longitude);
    const radNum = parseFloat(radiusMeters);

    if (isNaN(latNum) || latNum < -90 || latNum > 90) {
      setError("Latitude must be a valid number between -90 and 90.");
      return;
    }
    if (isNaN(lonNum) || lonNum < -180 || lonNum > 180) {
      setError("Longitude must be a valid number between -180 and 180.");
      return;
    }
    if (isNaN(radNum) || radNum < 5 || radNum > 50000) {
      setError("Radius must be between 5 meters and 50,000 meters.");
      return;
    }

    startTransition(async () => {
      try {
        const res = await updateGeofenceSettingsAction({
          enabled,
          latitude: latNum,
          longitude: lonNum,
          radiusMeters: radNum,
        });

        if (res.ok) {
          setConfig(res.settings);
          setSuccess("Geofence settings updated successfully!");
          router.refresh();
        } else if (res.code === "UNAUTHENTICATED") {
          router.replace("/admin/login");
        } else {
          setError(res.error);
        }
      } catch {
        setError("Failed to connect to server. Please try again.");
      }
    });
  }

  return (
    <section
      aria-label="Geofence Controls"
      className="mb-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3.5 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Geofence & Location Control
            </h2>
            <span
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold border ${
                config.enabled
                  ? "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800"
                  : "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800"
              }`}
            >
              <span className={`size-1.5 rounded-full ${config.enabled ? "bg-emerald-600" : "bg-amber-600"}`} />
              {config.enabled ? "Geofence Enforced" : "Direct Open Access"}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {config.enabled
              ? "Students must be physically within the radius to submit attendance."
              : "Geofence verification is disabled. Students skip GPS check and the form directly opens."}
          </p>
        </div>

        {config.updatedBy && (
          <div className="text-[11px] text-slate-400 dark:text-slate-500">
            Last updated by <span className="font-medium text-slate-600 dark:text-slate-300">{config.updatedBy}</span>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-lg border border-rose-300 bg-rose-50 dark:bg-rose-950/30 p-3 text-xs text-rose-800 dark:text-rose-200">
          {error}
        </div>
      )}

      {success && (
        <div role="status" className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs text-emerald-800 dark:text-emerald-200">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Toggle Switch */}
        <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-3.5">
          <div className="space-y-0.5">
            <label htmlFor="geofence-toggle" className="text-sm font-semibold text-slate-900 dark:text-white cursor-pointer">
              Geofence Verification Switch
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Turn OFF to allow all students to submit without browser location access.
            </p>
          </div>
          <button
            type="button"
            id="geofence-toggle"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled((prev) => !prev)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden ${
              enabled ? "bg-[#003a70]" : "bg-slate-300 dark:bg-slate-700"
            }`}
          >
            <span
              className={`pointer-events-none inline-block size-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                enabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Inputs Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="geo-lat" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Target Latitude
            </label>
            <input
              id="geo-lat"
              type="text"
              inputMode="decimal"
              className="input font-mono text-sm"
              value={latitude}
              onChange={(e) => setLatitude(e.target.value)}
              placeholder="e.g. 30.417006"
              required
            />
          </div>

          <div>
            <label htmlFor="geo-lon" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Target Longitude
            </label>
            <input
              id="geo-lon"
              type="text"
              inputMode="decimal"
              className="input font-mono text-sm"
              value={longitude}
              onChange={(e) => setLongitude(e.target.value)}
              placeholder="e.g. 77.966656"
              required
            />
          </div>

          <div>
            <label htmlFor="geo-rad" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              Perimeter Radius (meters)
            </label>
            <input
              id="geo-rad"
              type="number"
              min={5}
              max={50000}
              className="input font-mono text-sm"
              value={radiusMeters}
              onChange={(e) => setRadiusMeters(e.target.value)}
              placeholder="e.g. 100"
              required
            />
          </div>
        </div>

        {/* Quick action buttons & submit */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleUseMyLocation}
              disabled={detectingLocation}
              className="btn-secondary py-1.5 px-3 text-xs"
            >
              {detectingLocation ? <Spinner className="size-3.5 inline mr-1" /> : "📍 "}
              Use My Current Location
            </button>
            <button
              type="button"
              onClick={handleResetDefault}
              className="btn-secondary py-1.5 px-3 text-xs"
            >
              Reset to UPES Venue Default
            </button>
          </div>

          <button
            type="submit"
            disabled={pending}
            className="btn-primary py-2 px-5 text-sm font-semibold flex items-center gap-1.5 ml-auto"
          >
            {pending && <Spinner className="size-4" />}
            Save Geofence Settings
          </button>
        </div>
      </form>
    </section>
  );
}
