import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { QrActions } from "@/components/admin/qr-actions";
import { requireAdmin } from "@/lib/auth";
import { getAppUrl } from "@/lib/config";
import { qrMatrix } from "@/lib/qr";
import { qrPath } from "@/lib/qr-path";

export const metadata: Metadata = { title: "Attendance QR code", robots: { index: false, follow: false } };

const QUIET = 4;

/**
 * Printable workplace QR code. It encodes only the public attendance URL — no
 * location or personal data. It is a convenience, not a security control:
 * every check-in is still authorized by the server-side geofence check.
 */
export default async function QrPage() {
  await requireAdmin();
  const attendanceUrl = `${getAppUrl(await headers())}/attendance`;
  const rows = qrMatrix(attendanceUrl);
  const size = rows.length + QUIET * 2;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-10 print:max-w-none print:p-0">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <Link href="/admin" className="text-sm text-accent hover:underline">
            ← Back to dashboard
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Attendance QR code</h1>
          <p className="text-sm text-muted">Display this at the workplace. Employees scan it to open the attendance page.</p>
        </div>
      </header>

      {/* Poster — the only thing that prints */}
      <section
        id="qr-poster"
        className="relative overflow-hidden mx-auto flex max-w-md flex-col items-center rounded-2xl border border-border bg-white p-8 text-center text-black shadow-sm print:max-w-none print:border-0 print:shadow-none"
      >
        <div className="absolute inset-x-0 top-0 h-1.5 brand-stripe" />
        <div className="mb-4 flex items-center gap-3.5">
          <img src="/upes-logo.png" alt="UPES Logo" className="h-8 w-auto object-contain" />
          <div className="h-6 w-px bg-slate-300" />
          <img src="/samarth-logo.png" alt="SAMARTH Logo" className="h-8 w-auto object-contain" />
        </div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">SAMARTH INTERNSHIP 3.0</h2>
        <p className="text-sm font-semibold text-sky-800">Icebreaking Session Attendance</p>
        <p className="mt-1 text-xs text-neutral-600">Scan with your phone camera to check in</p>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          shapeRendering="crispEdges"
          className="mt-6 w-full max-w-80 print:max-w-[12cm]"
          role="img"
          aria-label={`QR code linking to ${attendanceUrl}`}
        >
          <rect width={size} height={size} fill="#fff" />
          <path d={qrPath(rows, QUIET)} fill="#000" />
        </svg>
        <p className="mt-4 break-all font-mono text-sm text-neutral-700">{attendanceUrl}</p>
        <p className="mt-4 text-xs text-neutral-500">Location access is required. You must be at the workplace to check in.</p>
      </section>

      <div className="print:hidden">
        <QrActions rows={rows} quiet={QUIET} url={attendanceUrl} />
        <p className="mt-6 text-sm text-muted">
          The QR code contains only the link above, with no location or personal data. Anyone with the link still has to pass
          the server-side location check (within the configured radius) before they can check in.
        </p>
      </div>
    </main>
  );
}
