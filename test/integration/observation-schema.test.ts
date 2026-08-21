import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { BuildObservationMarker } from '../../src/observation/toolkit-observation-port.js'

test('Toolkit build markers conform to the public Observation Schema', async () => {
  const schemaPath = path.resolve(
    process.cwd(),
    '../../BBQ/docs/interview/BT/proj/quickapp-kit/v3/spec/contracts/schemas/observation.schema.json',
  )
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
  const validate = new Ajv2020({ strict: true }).compile(schema)
  const markers: BuildObservationMarker[] = [
    {
      schemaVersion: 1,
      kind: 'observationMarker',
      runId: 'run:test',
      producer: 'toolkit',
      markerName: 'build.started',
      timestampNs: 1,
      clockDomain: 'test',
      sequence: 0,
    },
    {
      schemaVersion: 1,
      kind: 'observationMarker',
      runId: 'run:test',
      producer: 'toolkit',
      markerName: 'build.completed',
      timestampNs: 2,
      clockDomain: 'test',
      sequence: 1,
      artifactSha256: 'a'.repeat(64),
    },
    {
      schemaVersion: 1,
      kind: 'observationMarker',
      runId: 'run:test',
      producer: 'toolkit',
      markerName: 'build.failed',
      timestampNs: 3,
      clockDomain: 'test',
      sequence: 2,
      errorCode: 'TK_TEST_ERROR',
    },
  ]
  for (const marker of markers) assert.equal(validate(marker), true, JSON.stringify(validate.errors))
})
