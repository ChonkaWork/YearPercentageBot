import type { Tier } from './themes';

/**
 * Everything the page can show, in display order. The settings panel builds its "Show" switches
 * from this list, so a new widget is one entry here plus its renderer.
 */
export interface WidgetDefinition {
  id: string;
  label: string;
  tier: Tier;
  defaultVisible: boolean;
}

export const WIDGETS = [
  { id: 'clock', label: 'Clock and date', tier: 'free', defaultVisible: true },
  { id: 'year', label: 'Year', tier: 'free', defaultVisible: true },
  { id: 'month', label: 'Month', tier: 'free', defaultVisible: true },
  { id: 'week', label: 'Week', tier: 'free', defaultVisible: true },
  { id: 'day', label: 'Day', tier: 'free', defaultVisible: true },
  { id: 'countdowns', label: 'Countdowns', tier: 'free', defaultVisible: true },
] as const satisfies readonly WidgetDefinition[];

export type WidgetId = (typeof WIDGETS)[number]['id'];

export function isWidgetId(value: unknown): value is WidgetId {
  return WIDGETS.some((widget) => widget.id === value);
}
