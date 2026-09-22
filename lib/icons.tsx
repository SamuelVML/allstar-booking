/**
 * The redesigned All Star mark plus the interface icons the design calls for.
 *
 * The mark is a flat single-red star — the razor, stripes and script of the old
 * logo are gone. Interface icons are Lucide geometry inlined at the stroke
 * widths the design specifies, so the whole set ships without a runtime lookup.
 */

type IconProps = { className?: string; title?: string };

function stroke(props: IconProps, width = 2) {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: width,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: props.className,
    "aria-hidden": true,
  };
}

/** The All Star mark. Solid — takes its colour from `fill`. */
export function StarMark({ className, fill = "var(--red)" }: { className?: string; fill?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? "star-mark"} aria-hidden="true">
      <path fill={fill} d="M12 1.8l2.9 6.4 7 .8-5.2 4.8 1.4 6.9L12 17.2l-6.1 3.5 1.4-6.9L2.1 9l7-.8z" />
    </svg>
  );
}

export function ArrowRight(props: IconProps) {
  return <svg {...stroke(props)}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>;
}

export function ArrowLeft(props: IconProps) {
  return <svg {...stroke(props)}><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>;
}

export function ChevronLeft(props: IconProps) {
  return <svg {...stroke(props)}><path d="m15 18-6-6 6-6" /></svg>;
}

export function ChevronRight(props: IconProps) {
  return <svg {...stroke(props)}><path d="m9 18 6-6-6-6" /></svg>;
}

export function Check(props: IconProps & { strokeWidth?: number }) {
  return <svg {...stroke(props, props.strokeWidth ?? 2.5)}><path d="M20 6 9 17l-5-5" /></svg>;
}

export function Close(props: IconProps) {
  return <svg {...stroke(props)}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
}

export function Plus(props: IconProps) {
  return <svg {...stroke(props)}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
}

export function Search(props: IconProps) {
  return <svg {...stroke(props)}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>;
}

/* Backstage navigation — Lucide at stroke 1.6, as the design specifies. */

export function NavToday(props: IconProps) {
  return (
    <svg {...stroke(props, 1.6)}>
      <path d="M8 2v4" /><path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" /><path d="m9 16 2 2 4-4" />
    </svg>
  );
}

export function NavCalendar(props: IconProps) {
  return (
    <svg {...stroke(props, 1.6)}>
      <path d="M8 2v4" /><path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" /><path d="M12 14h.01" /><path d="M16 14h.01" />
      <path d="M8 18h.01" /><path d="M12 18h.01" /><path d="M16 18h.01" />
    </svg>
  );
}

export function NavCustomers(props: IconProps) {
  return (
    <svg {...stroke(props, 1.6)}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function NavRevenue(props: IconProps) {
  return (
    <svg {...stroke(props, 1.6)}>
      <path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" />
    </svg>
  );
}

export function NavSettings(props: IconProps) {
  return (
    <svg {...stroke(props, 1.6)}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
