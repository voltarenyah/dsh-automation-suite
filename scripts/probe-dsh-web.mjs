#!/usr/bin/env node
// Startup/cleanup probe for the desktop shell contract.
//
// It starts the real DSH Web host with the given profile and DSH_HOME, waits for
// the `dsh web: http://127.0.0.1:<port>/?token=…` line, prints one JSON object,
// and (by default) kills the whole process tree. The shell must do the same:
// direct Electron invocation, token never logged, timeout, no orphaned
// TiaOpennessV17Min.Controller.
//
// Usage:
//   node scripts/probe-dsh-web.mjs --dsh-home <home> --profile <name>
//   node scripts/probe-dsh-web.mjs --dsh-home <home> --profile <name> --keep
//
// Exit codes: 0 URL observed (and cleanup performed unless --keep), 1 failure.

import { execFileSync } from 'node:child_process'
import { spawnDsh } from './dsh-launch.mjs'

function parseArgs(argv) {
  const out = { port: 0, timeout: 60000 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    if (key === 'keep') {
      out.keep = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
    if (key === 'port' || key === 'timeout') out[key] = Number(value)
    else out[key] = value
    i += 1
  }
  return out
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // Already gone.
    }
    await wait(700)
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  await wait(500)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args['dsh-home']) throw new Error('--dsh-home is required')
  if (!args.profile) throw new Error('--profile is required')

  const child = spawnDsh(
    ['--profile', args.profile, '--port', String(args.port), '--no-open'],
    { env: { DSH_HOME: args['dsh-home'] } },
  )

  let stdout = ''
  let stderr = ''
  let finished = false
  const started = Date.now()
  const urlPattern = /dsh web: (http:\/\/127\.0\.0\.1:(\d+)\/\?token=\S+)/u

  const fail = async (message) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    await killTree(child.pid)
    const tail = stderr.split(/\r?\n/u).slice(-8).join('\n')
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: message,
        pid: child.pid,
        elapsedMs: Date.now() - started,
        stderrTail: tail,
      }, null, 2)}\n`,
    )
    process.exit(1)
  }

  const timer = setTimeout(() => {
    void fail(`no 'dsh web:' line within ${args.timeout} ms`)
  }, args.timeout)

  const inspect = () => {
    const match = urlPattern.exec(stdout)
    if (match === null || finished) return
    finished = true
    clearTimeout(timer)
    const url = match[1]
    const port = Number(match[2])
    const result = {
      ok: true,
      url,
      redactedUrl: url.replace(/token=[^&]+/u, 'token=<redacted>'),
      port,
      pid: child.pid,
      elapsedMs: Date.now() - started,
    }
    if (args.keep) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }
    void killTree(child.pid).then(() => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      process.exit(0)
    })
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => {
    stdout += chunk
    inspect()
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  child.on('error', (error) => {
    void fail(`failed to start DSH: ${error.message}`)
  })
  child.on('exit', (code, signal) => {
    if (finished) return
    void fail(`DSH exited before printing the URL (code=${code}, signal=${signal})`)
  })
}

main().catch((error) => {
  process.stderr.write(`probe-dsh-web: ${error.message}\n`)
  process.exit(1)
})
