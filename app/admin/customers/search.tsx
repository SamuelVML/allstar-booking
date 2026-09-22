"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "@/lib/icons";

/**
 * Search runs on the server so the match stays in SQL and never ships the
 * customer list to the browser. The input is debounced and drives the URL, so
 * a search can be shared, reloaded and navigated back out of.
 */
export default function CustomerSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  useEffect(() => {
    if (value === initialQuery) return;
    const timer = setTimeout(() => {
      const query = value.trim();
      router.replace(query ? `/admin/customers?q=${encodeURIComponent(query)}` : "/admin/customers");
    }, 250);
    return () => clearTimeout(timer);
  }, [value, initialQuery, router]);

  return (
    <label className="search">
      <Search />
      <span className="visually-hidden">Search customers</span>
      <input
        type="search"
        value={value}
        placeholder="Name, email or phone"
        autoComplete="off"
        onChange={(event) => setValue(event.target.value)}
      />
    </label>
  );
}
