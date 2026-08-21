#!/usr/bin/env node
import { CancellationController } from '../application/cancellation.js'
import { ToolkitApplicationService } from '../application/toolkit-application-service.js'
import { runCli } from './main.js'

const cancellation = new CancellationController()
const onSigint = () => cancellation.cancel('SIGINT')
const onSigterm = () => cancellation.cancel('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

try {
  const execution = await runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    service: new ToolkitApplicationService(),
    cancellation: cancellation.token,
    noColorEnvironment: Object.hasOwn(process.env, 'NO_COLOR'),
    io: {
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    },
  })
  process.exitCode = execution.exitCode
} finally {
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
}
