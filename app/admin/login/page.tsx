import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Admin sign in", robots: { index: false, follow: false } };

export default async function LoginPage() {
  if (await getAdminSession()) redirect("/admin");

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-12">
      <div className="mb-6 flex items-center justify-center gap-3">
        <div className="flex h-12 items-center justify-center rounded-xl bg-white px-3 py-1 shadow-2xs border border-border">
          <img src="/upes-logo.png" alt="UPES" className="h-8 w-auto object-contain" />
        </div>
        <div className="h-6 w-px bg-border" />
        <div className="flex h-12 items-center justify-center rounded-xl bg-white px-3 py-1 shadow-2xs border border-border">
          <img src="/samarth-logo.png" alt="SAMARTH" className="h-7 w-auto object-contain" />
        </div>
      </div>
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Admin Portal</h1>
        <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-400">
          SAMARTH INTERNSHIP 3.0
        </p>
      </div>
      <LoginForm />
    </main>
  );
}
