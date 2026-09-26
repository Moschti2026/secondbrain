import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { auth, signOut } from "@/auth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Secondbrain",
  description: "Dein persönlicher Cloud-Secondbrain über Drive, Microsoft 365 und lokale Dateien.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await auth();

  return (
    <html
      lang="de"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {session?.user && (
          <header className="border-b border-neutral-200 dark:border-neutral-800">
            <nav className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
              <Link href="/" className="font-semibold">
                🧠 Secondbrain
              </Link>
              <div className="flex items-center gap-4 text-sm">
                <Link href="/chat" className="hover:underline">Chat</Link>
                <Link href="/settings" className="hover:underline">Einstellungen</Link>
                <span className="text-neutral-400">{session.user.email}</span>
                <form
                  action={async () => {
                    "use server";
                    await signOut();
                  }}
                >
                  <button className="hover:underline" type="submit">
                    Abmelden
                  </button>
                </form>
              </div>
            </nav>
          </header>
        )}
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
