import { BookOpen, House, Layers, Plus, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type TabKey = "study" | "library" | "decks" | "settings";

export function MobileTabBar({ active, onSelect, onAdd }: {
  active: TabKey;
  onSelect: (tab: TabKey) => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();

  function tab(key: TabKey, icon: ReactNode, label: string) {
    const current = active === key;
    return (
      <button
        className={`mobile-tab ${current ? "mobile-tab-active" : ""}`}
        type="button"
        aria-current={current ? "page" : undefined}
        onClick={() => onSelect(key)}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }

  return (
    <nav className="mobile-tab-bar sm:hidden" aria-label={t("nav.menu")}>
      {tab("study", <House size={23} strokeWidth={2} />, t("ui.today"))}
      {tab("library", <BookOpen size={23} strokeWidth={2} />, t("nav.library"))}
      <button className="mobile-tab-add" type="button" aria-label={t("ui.addWords")} aria-haspopup="dialog" onClick={onAdd}>
        <Plus size={26} strokeWidth={2.4} />
      </button>
      {tab("decks", <Layers size={23} strokeWidth={2} />, t("nav.decks"))}
      {tab("settings", <SlidersHorizontal size={23} strokeWidth={2} />, t("nav.settings"))}
    </nav>
  );
}
