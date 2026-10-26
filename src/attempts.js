// Attempt counting, adapted from the Notion Claude review bundle
// (src/attempts.js, CommonJS) to ESM. Logic unchanged, including the hard
// cap of 3 total invocations across runs: a task whose Notion Attempts is
// already 3 will not run again until a human resets Attempts in Notion.
// That is a deliberate tightening over v0.1 (which only capped retries
// within one run); see docs/claude-review-landing.md.

export const HARD_CAP = 3;

export class AttemptTracker {
  constructor(baseAttempts = 0, { maxRetries = 1, hardCap = HARD_CAP } = {}) {
    this.base = Number.isInteger(baseAttempts) ? baseAttempts : 0;
    this.local = 0;
    this.maxRetries = Math.max(0, maxRetries);
    this.hardCap = Math.min(hardCap, HARD_CAP);
  }

  get total() {
    return this.base + this.local;
  }

  remainingThisRun() {
    const byRetry = 1 + this.maxRetries - this.local;
    const byCap = this.hardCap - this.total;
    return Math.max(0, Math.min(byRetry, byCap));
  }

  canAttempt() {
    return this.remainingThisRun() > 0;
  }

  next() {
    if (!this.canAttempt()) {
      throw new Error(`attempt budget exhausted (total=${this.total}, cap=${this.hardCap})`);
    }
    this.local += 1;
    return this.total;
  }
}
