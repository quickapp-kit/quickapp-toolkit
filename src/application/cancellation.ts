export type CancellationReason = 'requested' | 'SIGINT' | 'SIGTERM'

export interface CancellationToken {
  readonly cancelled: boolean
  readonly reason: CancellationReason | undefined
  throwIfCancelled(): void
}

export class OperationCancelledError extends Error {
  readonly reason: CancellationReason

  constructor(reason: CancellationReason) {
    super(`Operation cancelled: ${reason}`)
    this.name = 'OperationCancelledError'
    this.reason = reason
  }
}

export class CancellationController {
  #reason: CancellationReason | undefined
  readonly token: CancellationToken

  constructor() {
    const controller = this
    this.token = {
      get cancelled() {
        return controller.#reason !== undefined
      },
      get reason() {
        return controller.#reason
      },
      throwIfCancelled() {
        if (controller.#reason) throw new OperationCancelledError(controller.#reason)
      },
    }
  }

  cancel(reason: CancellationReason = 'requested'): void {
    this.#reason ??= reason
  }
}
