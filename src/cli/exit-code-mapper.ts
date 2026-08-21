import type { CancellationReason } from '../application/cancellation.js'
import type { RenderableResult } from './types.js'

export function exitCodeFor(result: RenderableResult, reason?: CancellationReason): number {
  if (result.status === 'success') return 0
  if (result.status === 'cancelled') {
    if (reason === 'SIGINT') return 130
    if (reason === 'SIGTERM') return 143
    return 10
  }
  switch (result.failure.kind) {
    case 'usage':
      return 2
    case 'workspace':
      return 3
    case 'config':
      return 4
    case 'operation':
    case 'cancelled':
      return 10
    case 'internal':
      return 70
  }
}
