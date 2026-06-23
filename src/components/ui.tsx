import type { ReactNode } from "react";

import type { LanguageCode } from "../types";

export function Label({ text, children }: { text: ReactNode; children: ReactNode }) {
  return (
    <label className="app-label grid min-w-0 gap-1 text-sm font-semibold">
      <span>{text}</span>
      {children}
    </label>
  );
}

export function HeaderSelect({ label, children, tooltip }: { label: string; children: ReactNode; tooltip?: string }) {
  return (
    <label className="app-subtle grid min-w-0 gap-1 text-xs font-semibold uppercase tracking-wide" data-tooltip={tooltip}>
      <span className="truncate">{label}</span>
      {children}
    </label>
  );
}

export function ViewTitle({ title }: { title: string }) {
  return <h2 className="app-heading text-2xl font-bold tracking-tight">{title}</h2>;
}

export function Metric({ label, value, compact = false, hint }: { label: string; value: string; compact?: boolean; hint?: string }) {
  return (
    <div className={`app-panel ${compact ? "p-3" : "p-4"}`} data-tooltip={hint} tabIndex={hint ? 0 : undefined}>
      <p className="app-muted text-sm font-semibold">{label}</p>
      <p className="app-heading text-2xl font-bold">{value}</p>
      {hint ? <p className="app-subtle mt-1 text-xs leading-relaxed">{hint}</p> : null}
    </div>
  );
}

export function NavButton({
  icon,
  label,
  active,
  onClick
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex min-h-10 w-full items-center gap-2 rounded-lg border px-3 text-sm font-semibold sm:min-h-11 sm:w-auto sm:rounded-none sm:border-x-0 sm:border-t-0 sm:border-b-2 ${
        active
          ? "nav-button-active"
          : "nav-button-inactive"
      }`}
      onClick={onClick}
      data-tooltip={label}
    >
      {icon}
      {label}
    </button>
  );
}

export function FlagIcon({ code }: { code: LanguageCode }) {
  const common = "h-4 w-6 shrink-0 overflow-hidden rounded-[3px] border border-slate-300 shadow-sm";

  if (code === "de") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#ffce00" />
        <rect width="30" height="13.33" fill="#dd0000" />
        <rect width="30" height="6.67" fill="#000000" />
      </svg>
    );
  }

  if (code === "fr") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="10" height="20" fill="#002395" />
        <rect x="10" width="10" height="20" fill="#ffffff" />
        <rect x="20" width="10" height="20" fill="#ed2939" />
      </svg>
    );
  }

  if (code === "it") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="10" height="20" fill="#009246" />
        <rect x="10" width="10" height="20" fill="#ffffff" />
        <rect x="20" width="10" height="20" fill="#ce2b37" />
      </svg>
    );
  }

  if (code === "es") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#aa151b" />
        <rect y="5" width="30" height="10" fill="#f1bf00" />
      </svg>
    );
  }

  if (code === "pt") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="12" height="20" fill="#006600" />
        <rect x="12" width="18" height="20" fill="#ff0000" />
        <circle cx="12" cy="10" r="3.4" fill="#ffcc00" />
        <circle cx="12" cy="10" r="2.1" fill="#ffffff" />
      </svg>
    );
  }

  if (code === "ru") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#d52b1e" />
        <rect width="30" height="13.33" fill="#0039a6" />
        <rect width="30" height="6.67" fill="#ffffff" />
      </svg>
    );
  }

  if (code === "bg") {
    return (
      <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
        <rect width="30" height="20" fill="#d62612" />
        <rect width="30" height="13.33" fill="#00966e" />
        <rect width="30" height="6.67" fill="#ffffff" />
      </svg>
    );
  }

  return (
    <svg className={common} viewBox="0 0 30 20" aria-hidden="true">
      <rect width="30" height="20" fill="#012169" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#ffffff" strokeWidth="4" />
      <path d="M0 0L30 20M30 0L0 20" stroke="#c8102e" strokeWidth="2" />
      <path d="M15 0V20M0 10H30" stroke="#ffffff" strokeWidth="7" />
      <path d="M15 0V20M0 10H30" stroke="#c8102e" strokeWidth="4" />
    </svg>
  );
}
