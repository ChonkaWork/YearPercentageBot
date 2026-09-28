import { isIndexFull, limitMessage, type Limits } from '../core/plan';
import type { SaveRequest, SaveResponse } from '../platform/messages';

/**
 * Why an automatic save must not happen, or null when it may. Manual saves (the popup button)
 * are explicit requests and always allowed.
 */
export function autoSaveRefusal(trigger: SaveRequest['trigger'], autoSave: boolean, incognito: boolean): Extract<SaveResponse, { ok: false }> | null {
  if (trigger === 'manual') return null;
  if (!autoSave) return { ok: false, code: 'AUTO_OFF', message: 'Auto-save is off.' };
  if (incognito) return { ok: false, code: 'INCOGNITO', message: 'Conversations in private windows are never saved automatically.' };
  return null;
}

/**
 * Why a conversation can't be added to the index, or null when it may. Only new conversations
 * count against the free limit: saved ones keep being updated, and nothing is ever deleted.
 * Applies to manual saves too (the popup explains why).
 */
export function limitRefusal(isNew: boolean, savedCount: number, limits: Limits): Extract<SaveResponse, { ok: false }> | null {
  if (!isNew || !isIndexFull(savedCount, limits)) return null;
  return { ok: false, code: 'LIMIT', message: limitMessage(limits) };
}
