import { ErrorCodes } from '../../diagnostics/error-codes.js'
import { OperationCancelledError } from '../../application/cancellation.js'
import { deepFreeze } from '../immutable.js'
import { FrontendIssue, issueDiagnostic } from './frontend-issue.js'
import { parseJavaScript } from './javascript-parser.js'
import { SourceCoordinateMap } from './source-coordinate-map.js'
import { parseStyle } from './style-parser.js'
import type { FrontendResult, ParseSourceRequest, ParsedSource, SourceFrontendPort } from './types.js'
import { DEFAULT_FRONTEND_LIMITS } from './types.js'
import { parseUx } from './ux-parser.js'

export class SourceFrontend implements SourceFrontendPort {
  async parse(request: ParseSourceRequest): Promise<FrontendResult> {
    request.cancellation.throwIfCancelled()
    const limits = request.limits ?? DEFAULT_FRONTEND_LIMITS
    const source = await request.sourceAccess.read(request.sourcePath, { content: 'strictUtf8', maxBytes: limits.maxSourceBytes })
    request.cancellation.throwIfCancelled()
    const text = source.text ?? ''
    const coordinates = new SourceCoordinateMap(text)
    try {
      let parsedSource: ParsedSource
      switch (request.sourceKind) {
        case 'appUx':
        case 'pageUx':
          parsedSource = parseUx(text, request.sourcePath, source.sha256, request.sourceKind, coordinates, limits)
          break
        case 'sharedJs': {
          const parsed = parseJavaScript(text, request.sourcePath, coordinates, 0, limits, false)
          parsedSource = Object.freeze({ sourcePath: request.sourcePath, sourceKind: 'sharedJs', sourceSha256: source.sha256, references: parsed.references, featureUsage: parsed.featureUsage, program: parsed.syntax })
          break
        }
        case 'style': {
          const parsed = parseStyle(text, request.sourcePath, coordinates, 0, limits, request.sourcePath.endsWith('.less') ? 'less' : 'css')
          parsedSource = Object.freeze({ sourcePath: request.sourcePath, sourceKind: 'style', sourceSha256: source.sha256, references: parsed.references, featureUsage: parsed.featureUsage, stylesheet: parsed.stylesheet })
          break
        }
      }
      request.cancellation.throwIfCancelled()
      return deepFreeze({ status: 'success', parsedSource: deepFreeze(parsedSource), diagnostics: [] } as const)
    } catch (error) {
      if (error instanceof OperationCancelledError) throw error
      if (error instanceof FrontendIssue) return { status: 'failure', diagnostics: Object.freeze([issueDiagnostic(error, request.sourcePath)]) }
      const span = coordinates.span(0, Math.min(1, text.length))
      const issue = new FrontendIssue(ErrorCodes.internalError, 'Unexpected frontend parser failure', span, 'Inspect the parser adapter failure and source input.')
      return { status: 'failure', diagnostics: Object.freeze([issueDiagnostic(issue, request.sourcePath)]) }
    }
  }
}
