/**
 * Endpoint detail tab bar — Metrics / Checks / Incidents / Notifications /
 * Settings. The overview tab from the previous design has been removed; the
 * Metrics tab now serves as the landing view.
 */
import { memo } from "react";
import { cn } from "@heroui/react";
import { Icon } from "@iconify/react";
import { CountPill } from "./primitives";

export type EndpointTabId =
  | "metrics"
  | "checks"
  | "incidents"
  | "notifications"
  | "settings";

interface TabDef {
  id: EndpointTabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: "metrics", label: "Metrics", icon: "solar:chart-square-linear" },
  {
    id: "checks",
    label: "Checks",
    icon: "solar:checklist-minimalistic-linear",
  },
  { id: "incidents", label: "Incidents", icon: "solar:danger-triangle-linear" },
  { id: "notifications", label: "Notifications", icon: "solar:bell-linear" },
  { id: "settings", label: "Settings", icon: "solar:settings-linear" },
];

interface Props {
  active: EndpointTabId;
  onSelect: (id: EndpointTabId) => void;
  counts?: Partial<Record<EndpointTabId, number | undefined>>;
}

function EndpointTabsBase({ active, onSelect, counts }: Props) {
  return (
    <div
      role="tablist"
      className="flex items-center gap-1 border-b border-wd-border/50 flex-wrap"
    >
      {TABS.map((t) => {
        const isActive = t.id === active;
        const count = counts?.[t.id];
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(t.id)}
            className={cn(
              "relative inline-flex items-center gap-1.5 px-3 h-9 text-[12.5px] transition-colors shrink-0 cursor-pointer",
              isActive
                ? "text-foreground font-semibold"
                : "text-wd-muted hover:text-foreground",
            )}
          >
            <Icon icon={t.icon} width={14} />
            {t.label}
            {count != null && count > 0 && (
              <CountPill value={count} muted={!isActive} />
            )}
            {isActive && (
              <span className="absolute left-2 right-2 -bottom-[1px] h-[2px] rounded-t-full bg-wd-primary" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export default memo(EndpointTabsBase);
