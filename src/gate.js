// Approval gate for the real Notion schema (see notion/schema.md):
// WriteMode is "read-only" or "write"; Approval is "Pending" or "Approved".
// This is the gate that was previously inline in bridge.js, extracted so it
// can be unit-tested. It can only ever be made stricter, never looser:
// read-only proceeds, write requires an explicit "Approved".
export function evaluateApprovalGate(task) {
  if (task.writeMode !== "write") return "proceed";
  if (task.approval === "Approved") return "proceed";
  return "needs-approval";
}
