/**
 * Shared building blocks for the endpoint detail rebuild. These match the
 * visual vocabulary already in use on IncidentsPage / NotificationsPage so
 * filter bars, dropdowns, and rainbow placeholders read the same across the
 * dashboard.
 */
import { memo, useRef, type ReactNode } from "react";
import {
  DateRangePicker,
  Dropdown,
  RangeCalendar,
  SearchField,
  TimeField,
  ToggleButton,
  ToggleButtonGroup,
  cn,
} from "@heroui/react";
import type { Selection } from "@heroui/react";
import type { DateValue, RangeValue, TimeValue } from "react-aria-components";
import { getLocalTimeZone, Time, today } from "@internationalized/date";
import { Icon } from "@iconify/react";

// ---------------------------------------------------------------------------
// Segmented toggle — matches IncidentsTable's filter-bar toggles exactly.
// ---------------------------------------------------------------------------

interface SegmentedOption<K extends string> {
  key: K;
  label: string;
  icon?: string;
}

interface SegmentedProps<K extends string> {
  options: SegmentedOption<K>[];
  value: K;
  onChange: (next: K) => void;
  ariaLabel?: string;
  size?: "sm" | "md";
  mono?: boolean;
  className?: string;
}

export function Segmented<K extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "sm",
  mono = false,
  className,
}: SegmentedProps<K>) {
  const groupClass = cn(
    "!h-8 !rounded-lg !border !border-wd-border/50 !bg-wd-surface !overflow-hidden",
    className,
  );
  const toggleClass = cn(
    "!text-xs !px-3 !h-full !rounded-none !border-0 !bg-transparent",
    "hover:!bg-wd-surface-hover",
    "[&:not(:first-child)]:!border-l [&:not(:first-child)]:!border-wd-border/50",
    "data-[selected=true]:!bg-wd-primary/15 data-[selected=true]:!text-wd-primary",
    mono && "!font-mono",
  );
  return (
    <ToggleButtonGroup
      aria-label={ariaLabel}
      selectionMode="single"
      selectedKeys={new Set([value])}
      onSelectionChange={(keys: Selection) => {
        const sel = [...keys][0] as K | undefined;
        if (sel) onChange(sel);
      }}
      size={size}
      className={groupClass}
    >
      {options.map((o) => (
        <ToggleButton key={o.key} id={o.key} className={toggleClass}>
          {o.icon && <Icon icon={o.icon} width={14} className="mr-1.5" />}
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

// ---------------------------------------------------------------------------
// Filter dropdown — mirrors NotificationsPage DeliveryLog's SelectDropdown so
// both surfaces use the same HeroUI Dropdown.Menu / Dropdown.Item path and
// pick up the compact `.dropdown__popover` overrides in globals.css.
// ---------------------------------------------------------------------------

interface FilterDropdownOption<T extends string> {
  id: T;
  label: string;
  /** CSS color for a leading status dot (hex or `var(--wd-…)`). */
  dot?: string;
}

interface FilterDropdownProps<T extends string> {
  value: T;
  options: FilterDropdownOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  minWidth?: number;
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}

export function FilterDropdown<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  minWidth = 180,
}: FilterDropdownProps<T>) {
  const current = options.find((o) => o.id === value) ?? options[0];
  return (
    <Dropdown>
      <Dropdown.Trigger>
        <div
          role="button"
          tabIndex={0}
          aria-label={ariaLabel}
          className={cn(
            "inline-flex items-center justify-between gap-2 h-8 px-2.5 rounded-lg text-xs cursor-pointer min-w-[140px]",
            "bg-wd-surface border border-wd-border/50 hover:bg-wd-surface-hover transition-colors",
          )}
        >
          <span className="inline-flex items-center gap-2 min-w-0">
            {current?.dot && <StatusDot color={current.dot} />}
            <span className="text-foreground truncate">
              {current?.label ?? "—"}
            </span>
          </span>
          <Icon
            icon="solar:alt-arrow-down-linear"
            width={16}
            className="text-wd-muted shrink-0"
          />
        </div>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom start" style={{ minWidth }}>
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={new Set([value])}
          onSelectionChange={(keys: Selection) => {
            const sel = [...keys][0];
            if (sel != null) onChange(String(sel) as T);
          }}
        >
          {options.map((opt) => (
            <Dropdown.Item key={opt.id} id={opt.id} className="!text-xs">
              {opt.dot && <StatusDot color={opt.dot} />}
              {opt.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

// ---------------------------------------------------------------------------
// Uniform search input (matches DeliveryLog / IncidentsTable search field)
// ---------------------------------------------------------------------------

interface FilterSearchProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  widthClass?: string;
}

export function FilterSearch({
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel = "Search",
  widthClass = "!w-64",
}: FilterSearchProps) {
  return (
    <SearchField
      aria-label={ariaLabel}
      value={value}
      onChange={onChange}
      className={widthClass}
    >
      <SearchField.Group className="!bg-wd-surface !border !border-wd-border/50 !rounded-lg !h-8">
        <SearchField.SearchIcon>
          <Icon
            icon="solar:magnifer-outline"
            width={16}
            className="text-wd-muted"
          />
        </SearchField.SearchIcon>
        <SearchField.Input placeholder={placeholder} className="!text-xs" />
        <SearchField.ClearButton>
          <Icon
            icon="solar:close-circle-outline"
            width={16}
            className="text-wd-muted"
          />
        </SearchField.ClearButton>
      </SearchField.Group>
    </SearchField>
  );
}

// ---------------------------------------------------------------------------
// Custom date-range filter — HeroUI DateRangePicker + RangeCalendar + TimeField
// pair, restyled so the trigger matches the filter bar (h-8, rounded-lg,
// bordered) and the popover offers both day and minute precision. Without
// time granularity a "Apr 5" range lumps a full day's checks together; the
// TimeField slots let the user pin the exact hour/minute an incident landed.
// ---------------------------------------------------------------------------

interface DateRangeFilterProps {
  value: RangeValue<DateValue> | null;
  onChange: (next: RangeValue<DateValue> | null) => void;
  ariaLabel?: string;
  placeholder?: string;
}

function hasTimeSegments(
  d: DateValue,
): d is DateValue & { hour: number; minute: number; second: number } {
  return "hour" in d;
}

function isMidnight(d: DateValue): boolean {
  if (!hasTimeSegments(d)) return true;
  return d.hour === 0 && d.minute === 0 && d.second === 0;
}

function isEndOfDay(d: DateValue): boolean {
  if (!hasTimeSegments(d)) return false;
  return d.hour === 23 && d.minute === 59;
}

function formatRangeLabel(v: RangeValue<DateValue>): string {
  const tz = getLocalTimeZone();
  const fmtDate = (d: DateValue) =>
    d.toDate(tz).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  const fmtTime = (d: DateValue) =>
    d.toDate(tz).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  // Hide times only when the range still reads as "full-day" on both ends
  // (start at 00:00, end at 23:59 or 00:00). Any user-set time surfaces in
  // the label so the filter state is self-describing.
  const showTime = !(
    isMidnight(v.start) &&
    (isMidnight(v.end) || isEndOfDay(v.end))
  );
  if (!showTime) return `${fmtDate(v.start)} – ${fmtDate(v.end)}`;
  return `${fmtDate(v.start)} ${fmtTime(v.start)} – ${fmtDate(v.end)} ${fmtTime(v.end)}`;
}

export function DateRangeFilter({
  value,
  onChange,
  ariaLabel = "Date range",
  placeholder = "Custom range",
}: DateRangeFilterProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hasValue = value != null;
  const label = hasValue ? formatRangeLabel(value) : placeholder;
  const maxValue = today(getLocalTimeZone());
  const handleChange = (next: RangeValue<DateValue> | null) => {
    if (!next) {
      onChange(null);
      return;
    }
    // First calendar selection from a cleared state yields midnight on both
    // endpoints; expand the end to 23:59:59 so "Apr 5 – Apr 6" covers both
    // full days. Any user-adjusted end time (non-midnight) is preserved.
    if (
      isMidnight(next.start) &&
      isMidnight(next.end) &&
      hasTimeSegments(next.end) &&
      "set" in next.end &&
      typeof (next.end as { set?: unknown }).set === "function"
    ) {
      const end = (
        next.end as unknown as {
          set: (v: {
            hour: number;
            minute: number;
            second: number;
          }) => DateValue;
        }
      ).set({ hour: 23, minute: 59, second: 59 });
      next = { start: next.start, end };
    }
    onChange(next);
  };
  return (
    <div className="relative inline-flex">
      <DateRangePicker
        aria-label={ariaLabel}
        value={value}
        onChange={handleChange}
        maxValue={maxValue}
        granularity="minute"
        hourCycle={12}
      >
        <DateRangePicker.Trigger
          ref={triggerRef}
          className={cn(
            "!inline-flex !w-auto !items-center !gap-1.5 !h-8 !px-3 !py-0",
            "!rounded-lg !text-xs !border !border-wd-border/50",
            "!bg-wd-surface hover:!bg-wd-surface-hover !transition-colors",
            "!cursor-pointer",
            hasValue && "!pr-8",
          )}
        >
          <Icon
            icon="solar:calendar-outline"
            width={14}
            className="text-wd-muted shrink-0"
          />
          <span
            className={cn(
              "truncate",
              hasValue ? "text-foreground" : "text-wd-muted",
            )}
          >
            {label}
          </span>
          {!hasValue && (
            <Icon
              icon="solar:alt-arrow-down-linear"
              width={14}
              className="text-wd-muted shrink-0"
            />
          )}
        </DateRangePicker.Trigger>
        <DateRangePicker.Popover
          triggerRef={triggerRef}
          placement="bottom start"
          className="!max-w-none !p-3 !rounded-xl !border !border-wd-border/50 !bg-wd-surface"
        >
          <RangeCalendar className="!w-[280px]">
            <RangeCalendar.Header>
              <RangeCalendar.NavButton slot="previous" />
              <RangeCalendar.Heading className="!text-[12px] !font-semibold" />
              <RangeCalendar.NavButton slot="next" />
            </RangeCalendar.Header>
            <RangeCalendar.Grid>
              <RangeCalendar.GridHeader>
                {(day) => (
                  <RangeCalendar.HeaderCell className="!text-[10px] !uppercase !tracking-wider !text-wd-muted">
                    {day}
                  </RangeCalendar.HeaderCell>
                )}
              </RangeCalendar.GridHeader>
              <RangeCalendar.GridBody>
                {(date) => (
                  <RangeCalendar.Cell date={date} className="!text-[11.5px]" />
                )}
              </RangeCalendar.GridBody>
            </RangeCalendar.Grid>
          </RangeCalendar>
          <div className="mt-3 pt-3 border-t border-wd-border/50 grid grid-cols-2 gap-2">
            <TimeFieldSlot
              endpoint="start"
              label="Start"
              value={value}
              onChange={handleChange}
            />
            <TimeFieldSlot
              endpoint="end"
              label="End"
              value={value}
              onChange={handleChange}
            />
          </div>
        </DateRangePicker.Popover>
      </DateRangePicker>
      {hasValue && (
        <button
          type="button"
          aria-label="Clear date range"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onChange(null);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 inline-flex items-center text-wd-muted hover:text-foreground cursor-pointer"
        >
          <Icon icon="solar:close-circle-outline" width={14} />
        </button>
      )}
    </div>
  );
}

// React Aria's DateRangePicker only exposes DateField slots, not TimeField
// slots, so a bare `<TimeField slot="start" />` renders but never writes back
// to the picker. We wire each TimeField explicitly: pull the time portion out
// of value.start / value.end, and on change merge it back into the matching
// endpoint via CalendarDateTime.set().
function TimeFieldSlot({
  endpoint,
  label,
  value,
  onChange,
}: {
  endpoint: "start" | "end";
  label: string;
  value: RangeValue<DateValue> | null;
  onChange: (next: RangeValue<DateValue> | null) => void;
}) {
  const node = value ? value[endpoint] : null;
  const timeValue: TimeValue | null =
    node && hasTimeSegments(node)
      ? new Time(node.hour, node.minute, node.second)
      : null;
  const isDisabled = !value || !node || !hasTimeSegments(node);
  const handleTimeChange = (next: TimeValue | null) => {
    if (!value || !next) return;
    const target = value[endpoint];
    if (!hasTimeSegments(target)) return;
    const updated = (
      target as unknown as {
        set: (v: { hour: number; minute: number; second: number }) => DateValue;
      }
    ).set({
      hour: next.hour,
      minute: next.minute,
      second: next.second,
    });
    onChange(
      endpoint === "start"
        ? { start: updated, end: value.end }
        : { start: value.start, end: updated },
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-wd-muted font-semibold">
        {label}
      </span>
      <TimeField
        value={timeValue}
        onChange={handleTimeChange}
        granularity="minute"
        hourCycle={12}
        isDisabled={isDisabled}
        aria-label={`${label} time`}
      >
        <TimeField.Group
          className={cn(
            "!inline-flex !items-center !h-8 !px-2 !gap-0.5",
            "!rounded-md !border !border-wd-border/50 !bg-wd-surface-hover/40",
            "!text-[11.5px] !font-mono !text-foreground",
            "focus-within:!border-wd-primary/50",
            isDisabled && "!opacity-60 !cursor-not-allowed",
          )}
        >
          <TimeField.Input className="!inline-flex !items-center !gap-[1px]">
            {(segment) => (
              <TimeField.Segment
                segment={segment}
                className={cn(
                  "!px-[1px] !rounded-[3px] !outline-none !caret-transparent",
                  "focus:!bg-wd-primary/15 focus:!text-wd-primary",
                  "data-[placeholder=true]:!text-wd-muted",
                )}
              />
            )}
          </TimeField.Input>
        </TimeField.Group>
      </TimeField>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section head — matches the small title/sub pattern used on IncidentsPage.
// ---------------------------------------------------------------------------

interface SectionHeadProps {
  icon?: string;
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
  className?: string;
}

export function SectionHead({
  icon,
  title,
  sub,
  right,
  className,
}: SectionHeadProps) {
  return (
    <div
      className={cn("flex items-start justify-between gap-3 mb-3", className)}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {icon && (
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-wd-primary/10 text-wd-primary shrink-0">
            <Icon icon={icon} width={14} />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-foreground truncate">
            {title}
          </div>
          {sub && (
            <div className="text-[11px] text-wd-muted mt-0.5 truncate">
              {sub}
            </div>
          )}
        </div>
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rainbow placeholder — animated gradient shell used when data isn't wired.
// Renders only the shimmering gradient, no overlay copy.
// ---------------------------------------------------------------------------

interface RainbowPlaceholderProps {
  className?: string;
  children?: ReactNode;
  /**
   * When true (default) the gradient animates. Set false for static blocks
   * that should simply look placeholder-y.
   */
  animated?: boolean;
  rounded?: string;
}

function RainbowPlaceholderBase({
  className,
  children,
  animated = true,
  rounded = "rounded-xl",
}: RainbowPlaceholderProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden border border-wd-border/40",
        rounded,
        className,
      )}
      style={{
        background:
          "linear-gradient(110deg, #ff6b6b, #f6c056, #5ac08a, #5ac8e8, #7c83f5, #c478e6, #ff6b6b)",
        backgroundSize: "300% 100%",
        animation: animated ? "wd-rainbow 9s linear infinite" : undefined,
      }}
    >
      {children && (
        <div className="relative z-10 p-4 bg-wd-surface/40 backdrop-blur-[2px] rounded-[inherit]">
          {children}
        </div>
      )}
    </div>
  );
}

export const RainbowPlaceholder = memo(RainbowPlaceholderBase);

// ---------------------------------------------------------------------------
// Counter pill used on tab labels.
// ---------------------------------------------------------------------------

export function CountPill({
  value,
  muted = false,
}: {
  value: number | string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex items-center justify-center px-1.5 h-[18px] rounded-md text-[10.5px] font-mono",
        muted
          ? "bg-wd-surface-hover text-wd-muted"
          : "bg-wd-primary/15 text-wd-primary",
      )}
    >
      {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Metric stat cell — reused in RT chart stats strip + metrics sub-cards.
// ---------------------------------------------------------------------------

interface StatCellProps {
  label: string;
  value: string | number;
  unit?: string;
  accent?: "primary" | "success" | "warning" | "danger" | "muted";
  mono?: boolean;
}

const accentText: Record<NonNullable<StatCellProps["accent"]>, string> = {
  primary: "text-wd-primary",
  success: "text-wd-success",
  warning: "text-wd-warning",
  danger: "text-wd-danger",
  muted: "text-foreground",
};

export function StatCell({
  label,
  value,
  unit,
  accent = "muted",
  mono = true,
}: StatCellProps) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-wd-muted font-semibold">
        {label}
      </span>
      <span
        className={cn(
          "text-[15px] font-semibold leading-none",
          mono && "font-mono",
          accentText[accent],
        )}
      >
        {value}
        {unit && (
          <span className="text-[11px] font-normal text-wd-muted ml-0.5">
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}
