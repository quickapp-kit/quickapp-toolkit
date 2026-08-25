import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js'
import type { ManifestSchemaValidator } from '../src/compiler/manifest/types.js'

export function caseRoot(caseName: 'quickapp-code-test1' | 'quickapp-code-test2' | 'quickapp-code-test3' | 'quickapp-code-test4' | 'quickapp-code-test5' | 'binding-001' | 'timer-001' | 'showcases/list-001' | 'showcases/media-001' | 'showcases/url-001' | 'showcases/tabs-001'): string {
  return path.resolve(process.cwd(), '..', 'quickapp-examples', caseName)
}

export async function publicManifestValidator(): Promise<ManifestSchemaValidator> {
  const schemaPath = path.resolve(
    process.cwd(),
    '..',
    '..',
    'BBQ/docs/interview/BT/proj/quickapp-kit/v3/spec/contracts/schemas/manifest.schema.json',
  )
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
  return {
    validate(value: unknown): readonly string[] {
      if (validate(value)) return []
      return (validate.errors ?? []).map((error: ErrorObject) => `${error.instancePath} ${error.message ?? 'invalid'}`)
    },
  }
}

export function validManifest(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    package: 'com.example.test',
    name: 'test',
    versionName: '1.0.0',
    versionCode: 1,
    minPlatformVersion: 1070,
    router: { entry: 'pages/Home', pages: { 'pages/Home': { component: 'index' } } },
    ...overrides,
  }
}
