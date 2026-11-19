import type { Model, PopulateOptions } from 'mongoose';
import type { Paginated } from './api';

export interface PageOptions {
  page: number;
  limit: number;
  sort?: Record<string, 1 | -1>;
  select?: string;
  populate?: PopulateOptions | PopulateOptions[];
}

export async function paginate<T = any>(
  model: Model<any>,
  filter: Record<string, unknown>,
  opts: PageOptions,
): Promise<Paginated<T>> {
  const { page, limit } = opts;
  const q = model
    .find(filter as any)
    .sort(opts.sort ?? { createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
  if (opts.select) q.select(opts.select);
  if (opts.populate) q.populate(opts.populate as any);
  const [items, total] = await Promise.all([q.lean(), model.countDocuments(filter as any)]);
  return {
    items: items as T[],
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/** Escape user text before using it inside a RegExp (prevents ReDoS / regex injection). */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function searchRegex(text: string | undefined): RegExp | undefined {
  const t = searchWords(text).join(' ');
  if (!t) return undefined;
  return new RegExp(escapeRegex(t.slice(0, 100)), 'i');
}

/** The words of a search: whitespace collapsed, at most 5 words of 50 characters. */
export function searchWords(text: string | undefined): string[] {
  return (text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((w) => w.slice(0, 50));
}

/**
 * A free-text filter where names may be split across fields or typed in any order: every word
 * must match one of `wordFields` ("Usman Bukhari", "bukhari  usman" and "usman" all find Usman
 * Bukhari, whose first and last names are stored apart), or the whole text matches one of
 * `wholeFields` (numbers, codes, emails, phone). `extra` adds other ready-made alternatives.
 * Case-insensitive, escaped; undefined when there is nothing to search for.
 */
export function textSearchFilter(
  text: string | undefined,
  wordFields: string[],
  wholeFields: string[] = [],
  extra: Record<string, unknown>[] = [],
): { $or: Record<string, unknown>[] } | undefined {
  const words = searchWords(text);
  if (!words.length) return undefined;
  const whole = searchRegex(text)!;
  const byWords = wordFields.length
    ? [
        {
          $and: words.map((w) => {
            const rx = new RegExp(escapeRegex(w), 'i');
            return { $or: wordFields.map((f) => ({ [f]: rx })) };
          }),
        },
      ]
    : [];
  return { $or: [...byWords, ...wholeFields.map((f) => ({ [f]: whole })), ...extra] };
}
