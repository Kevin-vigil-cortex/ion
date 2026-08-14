import { spawn } from 'node:child_process'
import type { Tool, ToolContext, ToolResult } from './types'
import { resolveUserPath } from './shell-env'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 64 * 1024

export const runTerminalTool: Tool = {
  name: 'run_terminal',
  description:
    'Run a shell command in the workspace root. Prefer file tools (read_file/edit_file/glob/grep) over shell for file work. Output is capped at 64KB — pipe to tail if you need the end (e.g. `cmd 2>&1 | tail -80`). Times out after 60s unless timeout_ms is set.',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute.' },
      timeout_ms: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000).'
      }
    },
    required: ['command'],
    additionalProperties: false
  },
  summarize: (args) => `run: ${String(args.command ?? '')}`,
  execute(args, ctx): Promise<ToolResult> {
    const command = args.command
    if (typeof command !== 'string') {
      return Promise.resolve({ output: 'Missing required string argument "command".', isError: true })
    }
    const timeout = Math.min(
      typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS,
      600_000
    )

    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn(command, {
        cwd: ctx.workspaceRoot,
        shell: true,
        env: { ...process.env, PATH: resolveUserPath() }
      })

      let out = ''
      let truncated = false
      let timedOut = false
      const append = (chunk: Buffer) => {
        if (out.length >= MAX_OUTPUT_BYTES) {
          truncated = true
          return
        }
        out += chunk.toString('utf8')
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeout)

      const onAbort = () => child.kill('SIGKILL')
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        resolvePromise({ output: `Failed to start command: ${err.message}`, isError: true })
      })

      child.on('close', (code, sig) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        const body = out.slice(0, MAX_OUTPUT_BYTES) + (truncated ? '\n[output truncated]' : '')
        const killed = sig === 'SIGKILL'
        // Distinguish timeout from user cancel so the model knows whether
        // retrying with a larger timeout_ms makes sense.
        const header = killed
          ? timedOut
            ? `Command timed out after ${timeout}ms and was killed. Retry with a larger timeout_ms (up to 600000) if it needs more time.`
            : 'Command was cancelled by the user.'
          : `Exit code: ${code ?? 'unknown'}`
        resolvePromise({
          output: `${header}\n\n${body || '(no output)'}`,
          isError: killed || (code ?? 1) !== 0,
          meta: { exitCode: code, killed }
        })
      })
    })
  }
}
