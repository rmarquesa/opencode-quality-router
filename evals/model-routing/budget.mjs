// Reference estimates only, not an invoice or a provider-enforced spending cap.
export class ReferenceBudget {
  constructor(limit) {
    if (!Number.isFinite(limit) || limit < 0)
      throw Error("Invalid reference budget");
    this.limit = limit;
    this.reserved = 0;
    this.pending = new Set();
  }
  reserve(bound) {
    if (!Number.isFinite(bound) || bound < 0)
      throw Error("Invalid reservation");
    if (this.reserved + bound > this.limit) return;
    const ticket = { bound };
    this.pending.add(ticket);
    this.reserved += bound;
    return ticket;
  }
  settle(ticket, reported) {
    if (!this.pending.delete(ticket)) return;
    // Missing/invalid metadata and timed-out requests retain the full bound.
    if (
      typeof reported === "number" &&
      Number.isFinite(reported) &&
      reported >= 0
    )
      this.reserved += reported - ticket.bound;
  }
}
