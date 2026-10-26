// OPTIONAL Phase-2 adapter — NOT wired into bridge.js v1, on purpose.
//
// yinguangyao/coding-agent-runner is a small Node SDK that wraps:
//   codex via `codex app-server --listen stdio://`, opencode via `opencode acp`,
// plus Claude/Cursor/Pi. It gives one normalized streaming API, abort and session
// resume, but it explicitly provides NO database, queue, sandbox or credential layer.
// That is exactly why it fits as an *execution* adapter inside AI Bridge, not as
// a replacement for it.
//
// Why v1 does NOT use it by default:
//  1. Its Codex path uses the experimental app-server, while `codex exec --json`
//     is the stable, auditable, officially documented non-interactive path.
//  2. Its OpenCode path uses ACP (`opencode acp`); the local OpenCode version on
//     the user's machine must be verified to support ACP before relying on it.
//  3. Token reporting through the normalized events is not guaranteed to match
//     the CLI's own --json output, and v1's promise is "tokens unknown, never invented".
//
// To try it (after the direct-exec loop is proven):
//   npm install coding-agent-runner
//   node -e "import('./src/runners/coding-agent-runner.mjs').then(m => m.runViaRunner({provider:'codex', cwd: process.cwd(), prompt: 'Reply with exactly RUNNER_OK'}).then(console.log))"
// Do NOT flip config.useCodingAgentRunner to true expecting bridge.js to use this
// file — bridge.js currently refuses that flag so nobody accidentally switches the
// proven path for an unverified one.
export async function runViaRunner({ provider, cwd, prompt, model }) {
  const { runCliAgent } = await import("coding-agent-runner");
  const result = await runCliAgent({ cwd, model, prompt, provider });
  return { output: result.output, sessionId: result.sessionId ?? null, tokens: null };
}
