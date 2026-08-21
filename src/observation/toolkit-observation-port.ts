export interface BuildObservationMarker {
  readonly schemaVersion: 1
  readonly kind: 'observationMarker'
  readonly runId: `run:${string}`
  readonly producer: 'toolkit'
  readonly markerName: 'build.started' | 'build.completed' | 'build.failed'
  readonly timestampNs: number
  readonly clockDomain: string
  readonly sequence: number
  readonly artifactSha256?: string
  readonly errorCode?: string
}

export interface ToolkitObservationPort {
  emit(marker: BuildObservationMarker): void
}

export interface MonotonicClock {
  nowNs(): number
  readonly domain: string
}

export class ProcessMonotonicClock implements MonotonicClock {
  readonly #origin = process.hrtime.bigint()
  readonly domain: string

  constructor(domain = `toolkit-process:${process.pid}`) {
    this.domain = domain
  }

  nowNs(): number {
    return Number(process.hrtime.bigint() - this.#origin)
  }
}

export class NoopToolkitObservationPort implements ToolkitObservationPort {
  emit(_marker: BuildObservationMarker): void {}
}

export class BuildObservationEmitter {
  readonly #port: ToolkitObservationPort
  readonly #clock: MonotonicClock
  readonly #runId: `run:${string}`
  #sequence = 0
  #terminal = false

  constructor(port: ToolkitObservationPort, clock: MonotonicClock, runId: `run:${string}`) {
    this.#port = port
    this.#clock = clock
    this.#runId = runId
  }

  started(): void {
    this.#safeEmit('build.started')
  }

  completed(artifactSha256?: string): void {
    if (this.#terminal) return
    this.#terminal = true
    this.#safeEmit('build.completed', artifactSha256 === undefined ? {} : { artifactSha256 })
  }

  failed(errorCode: string): void {
    if (this.#terminal) return
    this.#terminal = true
    this.#safeEmit('build.failed', { errorCode })
  }

  #safeEmit(
    markerName: BuildObservationMarker['markerName'],
    extra: Pick<BuildObservationMarker, 'artifactSha256' | 'errorCode'> = {},
  ): void {
    const marker: BuildObservationMarker = {
      schemaVersion: 1,
      kind: 'observationMarker',
      runId: this.#runId,
      producer: 'toolkit',
      markerName,
      timestampNs: this.#clock.nowNs(),
      clockDomain: this.#clock.domain,
      sequence: this.#sequence++,
      ...extra,
    }
    try {
      this.#port.emit(marker)
    } catch {
      // Observation is best effort and cannot change Toolkit behavior.
    }
  }
}
