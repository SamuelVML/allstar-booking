import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "All Star Barbershop | Eindhoven",
  description:
    "All Star Barbershop in Eindhoven — precision cuts, beard grooming, barber education and the upcoming Mobile Barber.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
