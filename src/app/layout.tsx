import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Algotred — бэктест",
  description: "Локальная оболочка над движком бэктеста (этап 1)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            Algotred
          </Link>
          <nav>
            <Link href="/chart">График</Link>
            <Link href="/data">Данные</Link>
            <Link href="/backtest">Бэктест</Link>
            <Link href="/reports">Отчёты</Link>
            <Link href="/signals">Сигналы</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
