/**
 * Cursor pagination helpers (Phase 0).
 *
 * Usage in a service:
 *   const { take, cursorArgs } = parseCursor(query);           // query.cursor, query.limit
 *   const rows = await prisma.model.findMany({ ...cursorArgs, take: take + 1, orderBy: { id: 'desc' } });
 *   return buildCursorPage(rows, take);                        // { items, nextCursor, hasMore }
 *
 * Contract: results MUST be ordered by a unique column (we use `id` desc by default).
 * Cursor mode never runs a COUNT(*) — that is what makes it fast on big tables.
 */

export interface CursorQuery {
  cursor?: string | number;
  limit?: string | number;
}

export interface CursorArgs {
  take: number;
  cursorArgs: { cursor?: { id: number }; skip?: number };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: number | null;
  hasMore: boolean;
}

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export function parseCursor(query?: CursorQuery): CursorArgs {
  const rawLimit = Number(query?.limit);
  const take = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  const rawCursor = Number(query?.cursor);
  const cursorArgs: CursorArgs['cursorArgs'] =
    Number.isFinite(rawCursor) && rawCursor > 0 ? { cursor: { id: rawCursor }, skip: 1 } : {};

  return { take, cursorArgs };
}

/** Pass rows fetched with `take + 1`; trims the extra row and derives nextCursor. */
export function buildCursorPage<T extends { id: number }>(rows: T[], take: number): CursorPage<T> {
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  const nextCursor = hasMore && items.length ? items[items.length - 1].id : null;
  return { items, nextCursor, hasMore };
}
