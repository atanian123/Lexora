import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";

interface SelectOption {
  value: string;
  label: ReactNode;
}

export function AppSelect({
  label,
  value,
  defaultValue,
  options,
  onChange,
  compact = false,
  disabled = false,
  wrap = false,
  placement = "below",
  ariaLabel,
  tooltip
}: {
  label?: ReactNode;
  value?: string;
  defaultValue?: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  compact?: boolean;
  disabled?: boolean;
  wrap?: boolean;
  placement?: "above" | "below";
  ariaLabel?: string;
  tooltip?: string;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [localValue, setLocalValue] = useState(defaultValue);
  const selected = options.find((option) => option.value === (value ?? localValue)) ?? options[0];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected?.value));
  const expanded = open && !disabled;
  const textClass = wrap ? "min-w-0 whitespace-normal wrap-break-word" : "min-w-0 truncate";

  useEffect(() => {
    if (!expanded) return;

    function closeOutside(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [expanded]);

  function select(next: string) {
    if (value === undefined) setLocalValue(next);
    onChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
      return;
    }

    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    const lastIndex = options.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? lastIndex
          : event.key === "ArrowDown"
            ? Math.min(lastIndex, selectedIndex + 1)
            : Math.max(0, selectedIndex - 1);
    const next = options[nextIndex];
    if (next) select(next.value);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  const control = (
    <div
      ref={container}
      className="relative min-w-0 max-w-full"
      onBlur={(event) => {
        // Safari can blur the trigger without focusing the option being clicked.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        className={`app-input flex min-w-0 items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${compact ? "app-input-compact min-h-9" : "min-h-10"}`}
        type="button"
        disabled={disabled || options.length === 0}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={`${id}-options`}
        aria-label={ariaLabel}
        aria-labelledby={label && !ariaLabel ? `${id}-label ${id}-value` : undefined}
        data-tooltip={expanded ? "" : tooltip}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
      >
        <span id={`${id}-value`} className={textClass}>{selected?.label}</span>
        <ChevronRight className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} size={compact ? 15 : 16} />
      </button>
      <div
        id={`${id}-options`}
        className={`app-panel dropdown-panel absolute z-40 max-h-72 w-full p-1 ${placement === "above" ? "dropdown-panel-above bottom-full mb-1" : "mt-1"} ${expanded ? "dropdown-panel-open" : ""}`}
        role="listbox"
        aria-label={ariaLabel}
        aria-labelledby={label && !ariaLabel ? `${id}-label` : undefined}
        aria-hidden={!expanded}
      >
        {options.map((option) => (
          <button
            key={option.value}
            className={`dropdown-option flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm ${
              option.value === selected?.value ? "dropdown-option-active" : ""
            }`}
            type="button"
            role="option"
            aria-selected={option.value === selected?.value}
            tabIndex={expanded ? 0 : -1}
            onClick={() => {
              select(option.value);
              close();
            }}
          >
            <span className={textClass}>{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  if (!label) {
    return control;
  }

  return (
    <div className="app-label grid min-w-0 gap-1 text-sm font-semibold">
      <span id={`${id}-label`}>{label}</span>
      {control}
    </div>
  );
}
