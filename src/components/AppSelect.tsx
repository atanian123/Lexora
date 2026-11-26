import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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
  const menu = useRef<HTMLDivElement>(null);
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

  useLayoutEffect(() => {
    const button = trigger.current;
    const panel = menu.current;
    const dialog = button?.closest("dialog[open]");
    if (!expanded || !button || !panel || !dialog) return;

    if (typeof panel.showPopover !== "function") {
      panel.dataset.dialogMenu = "inline";
      return () => { delete panel.dataset.dialogMenu; };
    }

    // A dialog's scroll box and sticky header cannot clip a top-layer popover.
    panel.dataset.dialogMenu = "popover";
    panel.setAttribute("popover", "manual");
    panel.showPopover();
    const heightLimit = Number.parseFloat(getComputedStyle(panel).maxHeight);
    const header = dialog.querySelector(".app-task-dialog-header");
    const viewport = window.visualViewport;
    const inset = 8;
    const gap = 4;

    const position = () => {
      const anchor = button.getBoundingClientRect();
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const topLimit = Math.max(viewportTop + inset, header?.getBoundingClientRect().bottom ?? 0);
      if (anchor.bottom <= topLimit || anchor.top >= Math.min(viewportBottom, dialog.getBoundingClientRect().bottom)) {
        setOpen(false);
        return;
      }

      const width = Math.min(anchor.width, viewportWidth - 2 * inset);
      const left = Math.min(Math.max(anchor.left, viewportLeft + inset), viewportLeft + viewportWidth - inset - width);
      panel.style.width = `${width}px`;
      panel.style.left = `${left}px`;

      const desiredHeight = Math.min(panel.scrollHeight + panel.offsetHeight - panel.clientHeight, heightLimit);
      const above = Math.max(0, anchor.top - gap - topLimit);
      const below = Math.max(0, viewportBottom - inset - anchor.bottom - gap);
      const opensAbove = placement === "above" ? above >= desiredHeight || above > below : below < desiredHeight && above > below;
      const height = Math.min(desiredHeight, opensAbove ? above : below);
      panel.style.maxHeight = `${height}px`;
      panel.style.top = `${opensAbove ? anchor.top - gap - height : anchor.bottom + gap}px`;
    };

    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    dialog.addEventListener("animationend", position);
    return () => {
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      dialog.removeEventListener("animationend", position);
      if (panel.matches(":popover-open")) panel.hidePopover();
      panel.removeAttribute("popover");
      panel.removeAttribute("style");
      delete panel.dataset.dialogMenu;
    };
  }, [expanded, options.length, placement]);

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
    trigger.current?.focus({ preventScroll: true });
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
        className={`app-input app-select-trigger flex min-w-0 items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60 ${compact ? "app-input-compact min-h-9" : "min-h-10"}`}
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
        <ChevronDown className={`app-select-chevron shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} size={compact ? 16 : 18} aria-hidden="true" />
      </button>
      <div
        ref={menu}
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
