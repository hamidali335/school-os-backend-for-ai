import { badRequest } from '../../utils/errors';
/**
 * Deterministic fee arithmetic. All amounts are whole rupees (integers). This module is
 * the single source of truth for fee totals; AI features may explain these numbers but
 * never compute them.
 */

export interface LineItem {
  name: string;
  amount: number;
  concessionApplies?: boolean;
}

export interface Concession {
  type?: 'none' | 'percent' | 'fixed' | null;
  value?: number | null;
}

export function assertWholeRupees(...values: number[]) {
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`Invalid amount: ${v}`);
  }
}

export function subtotalOf(items: LineItem[]): number {
  return items.reduce((sum, i) => sum + i.amount, 0);
}

/** Concession applies only to items flagged `concessionApplies` (typically tuition). */
export function concessionAmount(items: LineItem[], concession: Concession | null | undefined): number {
  if (!concession || !concession.type || concession.type === 'none' || !concession.value) return 0;
  const base = items.filter((i) => i.concessionApplies).reduce((s, i) => s + i.amount, 0);
  if (concession.type === 'percent') {
    const pct = Math.min(Math.max(concession.value, 0), 100);
    return Math.round((base * pct) / 100);
  }
  return Math.min(Math.round(concession.value), base);
}

export interface Totals {
  subtotal: number;
  concession: number;
  waiver: number;
  lateFee: number;
  total: number;
}

export function computeTotals(input: {
  items: LineItem[];
  concession?: Concession | null;
  waiver?: number;
  lateFee?: number;
}): Totals {
  const subtotal = subtotalOf(input.items);
  const concession = concessionAmount(input.items, input.concession);
  const waiver = input.waiver ?? 0;
  const lateFee = input.lateFee ?? 0;
  assertWholeRupees(subtotal, concession, waiver, lateFee);
  const total = Math.max(0, subtotal - concession - waiver + lateFee);
  return { subtotal, concession, waiver, lateFee, total };
}

export type InvoiceStatus = 'unpaid' | 'partial' | 'paid' | 'waived' | 'cancelled';

export function statusFor(total: number, paid: number, waiver = 0): InvoiceStatus {
  const balance = total - paid;
  if (balance <= 0) {
    if (paid === 0 && waiver > 0) return 'waived';
    return 'paid';
  }
  return paid > 0 ? 'partial' : 'unpaid';
}

/** Split an amount into `count` installments; any remainder goes to the last one. */
export function splitInstallments(amount: number, count: number, firstDue: Date, intervalDays: number) {
  assertWholeRupees(amount);
  if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be a positive integer');
  const base = Math.floor(amount / count);
  return Array.from({ length: count }, (_, i) => ({
    no: i + 1,
    amount: i === count - 1 ? amount - base * (count - 1) : base,
    dueDate: new Date(firstDue.getTime() + i * intervalDays * 86_400_000),
  }));
}

/**
 * Allocate a payment across installments, earliest first, given how much had already
 * been paid before this payment.
 */
export function allocatePayment(
  installments: Array<{ no: number; amount: number }>,
  alreadyPaid: number,
  payment: number,
) {
  const allocations: Array<{ installmentNo: number; amount: number }> = [];
  let priorRemaining = alreadyPaid;
  let toAllocate = payment;
  for (const inst of [...installments].sort((a, b) => a.no - b.no)) {
    const coveredByPrior = Math.min(inst.amount, priorRemaining);
    priorRemaining -= coveredByPrior;
    const open = inst.amount - coveredByPrior;
    if (open <= 0 || toAllocate <= 0) continue;
    const take = Math.min(open, toAllocate);
    allocations.push({ installmentNo: inst.no, amount: take });
    toAllocate -= take;
  }
  return allocations;
}

/**
 * The installment a challan is for: the requested one, or the first with an amount still due
 * (the last one when everything is paid). Undefined when the invoice is not split.
 */
export function pickInstallment(
  plan: Array<{ no: number; amount: number; paid: number; outstanding: number; dueDate: Date }>,
  requested?: number,
) {
  if (!plan.length) {
    if (requested) throw badRequest('This invoice is not split into installments', { field: 'installment' });
    return undefined;
  }
  const chosen = requested
    ? plan.find((p) => p.no === requested)
    : (plan.find((p) => p.outstanding > 0) ?? plan[plan.length - 1]);
  if (!chosen) throw badRequest(`This invoice has ${plan.length} installments`, { field: 'installment' });
  return {
    no: chosen.no,
    count: plan.length,
    amount: chosen.amount,
    paid: chosen.paid,
    outstanding: chosen.outstanding,
    dueDate: chosen.dueDate,
  };
}

/** Installment status derived from cumulative payments (no per-installment counters to drift). */
export function installmentStatus(
  installments: Array<{ no: number; amount: number; dueDate: Date }>,
  paid: number,
  today: Date,
) {
  let remaining = paid;
  return [...installments]
    .sort((a, b) => a.no - b.no)
    .map((inst) => {
      const covered = Math.min(inst.amount, remaining);
      remaining -= covered;
      const outstanding = inst.amount - covered;
      return {
        ...inst,
        paid: covered,
        outstanding,
        // Past-due with anything outstanding is overdue, even if partly paid.
        status: outstanding === 0 ? 'paid' : inst.dueDate < today ? 'overdue' : covered > 0 ? 'partial' : 'due',
      };
    });
}

/** Which structure items are billable in a given billing period (YYYY-MM)? */
export function billableItems<T extends { frequency: string; billingMonths?: number[] }>(
  items: T[],
  period: string,
  isFirstInvoice: boolean,
): T[] {
  const month = Number(period.slice(5, 7));
  return items.filter((i) => {
    if (i.frequency === 'monthly') return true;
    if (i.frequency === 'annual' || i.frequency === 'term') return (i.billingMonths ?? []).includes(month);
    if (i.frequency === 'one_time') return isFirstInvoice;
    return false;
  });
}

// ───────────────────── Fee-head breakdown and payment allocation ─────────────────────

export interface InvoiceForLines {
  items: Array<{ name: string; amount: number; concessionApplies?: boolean | null; feeHeadId?: unknown }>;
  concession: number;
  waiver: number;
  lateFee: number;
  balance: number;
}

export interface InvoiceLine {
  /** Item index ("0", "1"...) or "late_fee". Stable for the life of the invoice. */
  line: string;
  name: string;
  feeHeadId: string | null;
  charged: number;
  /** Share of the standing concession on this line. */
  discount: number;
  /** charged - discount: what this line asks to be paid (before any waiver). */
  net: number;
}

export interface LineStatus extends InvoiceLine {
  paid: number;
  waived: number;
  outstanding: number;
  status: 'paid' | 'partial' | 'unpaid';
}

export interface PaymentForLines {
  amount: number;
  headAllocations?: Array<{ line: string; amount: number }> | null;
}

/**
 * The invoice as payable lines. The concession reduces only the lines it applies to, in item
 * order (the same base fee-calc used to compute it), so the lines always add up to
 * total + waiver.
 */
export function invoiceLines(inv: InvoiceForLines): InvoiceLine[] {
  let concessionLeft = inv.concession ?? 0;
  const lines: InvoiceLine[] = inv.items.map((it, i) => {
    const discount = it.concessionApplies ? Math.min(it.amount, concessionLeft) : 0;
    concessionLeft -= discount;
    return {
      line: String(i),
      name: it.name,
      feeHeadId: it.feeHeadId ? String(it.feeHeadId) : null,
      charged: it.amount,
      discount,
      net: it.amount - discount,
    };
  });
  // Defensive: a concession larger than its base (older data) still reduces the invoice.
  for (const l of lines) {
    if (concessionLeft <= 0) break;
    const extra = Math.min(l.net, concessionLeft);
    l.discount += extra;
    l.net -= extra;
    concessionLeft -= extra;
  }
  if (inv.lateFee > 0)
    lines.push({
      line: 'late_fee',
      name: 'Late fee',
      feeHeadId: null,
      charged: inv.lateFee,
      discount: 0,
      net: inv.lateFee,
    });
  return lines;
}

/**
 * Which lines are paid, waived and outstanding. Explicit allocations (chosen by staff) settle
 * their lines first; other payments and then any waiver settle the remaining lines in order.
 * Only pass valid (not reversed) payments.
 */
export function headBreakdown(inv: InvoiceForLines, payments: PaymentForLines[]): LineStatus[] {
  const lines = invoiceLines(inv);
  const paid = new Map(lines.map((l) => [l.line, 0]));
  let unallocated = 0;
  for (const p of payments) {
    let explicit = 0;
    for (const a of p.headAllocations ?? []) {
      if (!paid.has(a.line)) continue;
      paid.set(a.line, paid.get(a.line)! + a.amount);
      explicit += a.amount;
    }
    unallocated += Math.max(0, p.amount - explicit);
  }
  const waived = new Map(lines.map((l) => [l.line, 0]));
  const fill = (pool: number, into: Map<string, number>) => {
    for (const l of lines) {
      if (pool <= 0) break;
      const room = l.net - paid.get(l.line)! - waived.get(l.line)!;
      if (room <= 0) continue;
      const take = Math.min(room, pool);
      into.set(l.line, into.get(l.line)! + take);
      pool -= take;
    }
  };
  fill(unallocated, paid);
  fill(inv.waiver ?? 0, waived);
  return lines.map((l) => {
    const p = paid.get(l.line)!;
    const w = waived.get(l.line)!;
    const outstanding = Math.max(0, l.net - p - w);
    return {
      ...l,
      paid: p,
      waived: w,
      outstanding,
      status: outstanding === 0 ? 'paid' : p + w > 0 ? 'partial' : 'unpaid',
    };
  });
}

/** Checks a staff-chosen allocation against what is still outstanding on each line. */
export function validateHeadAllocation(
  lines: LineStatus[],
  allocations: Array<{ line: string; amount: number }>,
  paymentAmount: number,
): Array<{ line: string; name: string; amount: number }> {
  const byLine = new Map(lines.map((l) => [l.line, l]));
  const seen = new Set<string>();
  let sum = 0;
  const out: Array<{ line: string; name: string; amount: number }> = [];
  for (const a of allocations) {
    if (!Number.isInteger(a.amount) || a.amount < 0) throw badRequest('Allocated amounts must be whole rupees');
    if (a.amount === 0) continue;
    const l = byLine.get(a.line);
    if (!l) throw badRequest(`Unknown invoice line "${a.line}"`, { field: 'headAllocations' });
    if (seen.has(a.line)) throw badRequest(`${l.name} is listed twice`, { field: 'headAllocations' });
    seen.add(a.line);
    if (a.amount > l.outstanding)
      throw badRequest(`Only Rs ${l.outstanding} is outstanding on ${l.name}`, { field: 'headAllocations' });
    sum += a.amount;
    out.push({ line: a.line, name: l.name, amount: a.amount });
  }
  if (sum !== paymentAmount)
    throw badRequest(`The allocation adds up to Rs ${sum}, but the payment is Rs ${paymentAmount}`, {
      field: 'headAllocations',
    });
  return out;
}

/**
 * The fees a payment settles when staff did not choose: what is outstanding, line by line in the
 * invoice's order (the same order unallocated payments always followed). Recorded with the payment
 * so its receipt can say exactly what it paid for. Any part that finds nothing outstanding (older
 * data out of step) stays unallocated rather than being guessed.
 */
export function autoAllocate(
  lines: LineStatus[],
  amount: number,
): Array<{ line: string; name: string; amount: number }> {
  const out: Array<{ line: string; name: string; amount: number }> = [];
  let left = amount;
  for (const l of lines) {
    if (left <= 0) break;
    if (l.outstanding <= 0) continue;
    const take = Math.min(l.outstanding, left);
    out.push({ line: l.line, name: l.name, amount: take });
    left -= take;
  }
  return out;
}

export interface ReceiptLine {
  name: string;
  /** Outstanding on this fee just before the payment. */
  due: number;
  paidNow: number;
  /** Still outstanding on this fee right after the payment. */
  remaining: number;
}

/**
 * A payment's fee breakdown for its receipt: for each fee it paid (and each fee still due), what
 * was due before it, what it paid and what remained. `earlier` are the valid payments recorded
 * before this one. Waivers are left out of "due" (they may have come later).
 */
export function receiptLines(
  inv: InvoiceForLines,
  earlier: PaymentForLines[],
  payment: { amount: number; headAllocations: Array<{ line: string; amount: number }> },
): { lines: ReceiptLine[]; unallocated: number } {
  const before = headBreakdown({ ...inv, waiver: 0 }, earlier);
  const now = new Map(payment.headAllocations.map((a) => [a.line, a.amount]));
  const lines = before
    .map((l) => {
      const paidNow = now.get(l.line) ?? 0;
      return { name: l.name, due: l.outstanding, paidNow, remaining: Math.max(0, l.outstanding - paidNow) };
    })
    .filter((l) => l.due > 0 || l.paidNow > 0);
  const allocated = payment.headAllocations.reduce((s, a) => s + a.amount, 0);
  return { lines, unallocated: Math.max(0, payment.amount - allocated) };
}
