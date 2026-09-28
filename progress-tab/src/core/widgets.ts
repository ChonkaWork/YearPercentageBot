import type { Tiered } from './plan';

/**
 * Everything the page can show, in display order. The settings panel builds its "Show" switches
 * from this list, so a new widget is one entry here plus its renderer. Pro widgets name the Pro
 * feature they belong to (see plan.ts).
 */
export type WidgetDefinition = {
  id: string;
  label: string;
  defaultVisible: boolean;
} & Tiered;

export const WIDGETS = [
  { id: 'clock', label: 'Clock and date', tier: 'free', defaultVisible: true },
  { id: 'year', label: 'Year', tier: 'free', defaultVisible: true },
  { id: 'month', label: 'Month', tier: 'free', defaultVisible: true },
  { id: 'week', label: 'Week', tier: 'free', defaultVisible: true },
  { id: 'day', label: 'Day', tier: 'free', defaultVisible: true },
  { id: 'countdowns', label: 'Countdowns', tier: 'free', defaultVisible: true },
  // Off by default: it needs a birth date, and not everyone wants to see it on every tab.
  { id: 'lifeWeeks', label: 'Life in weeks', tier: 'pro', feature: 'life-in-weeks', defaultVisible: false },
] as const satisfies readonly WidgetDefinition[];

export type WidgetId = (typeof WIDGETS)[number]['id'];

export function isWidgetId(value: unknown): value is WidgetId {
  return WIDGETS.some((widget) => widget.id === value);
}
