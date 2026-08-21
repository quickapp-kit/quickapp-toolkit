export interface FrontendFeature {
  readonly featureId: string
  readonly sourceKind: 'ux' | 'script' | 'style'
  readonly status: 'supported' | 'rejectedV1'
  readonly evidence: 'case001' | 'case002' | 'negative'
  readonly ownerPhase: 'frontend' | 'lowering' | 'emitter'
}

export const FRONTEND_FEATURE_MATRIX: readonly FrontendFeature[] = Object.freeze([
  feature('ux.fragment.app-script-optional-style', 'ux', 'supported', 'case001', 'frontend'),
  feature('ux.fragment.page-template-script-style', 'ux', 'supported', 'case001', 'frontend'),
  feature('template.tag.div/text/input', 'ux', 'supported', 'case001', 'lowering'),
  feature('template.attr.class/type/value', 'ux', 'supported', 'case001', 'lowering'),
  feature('template.event.onclick', 'ux', 'supported', 'case001', 'lowering'),
  feature('template.directive.if', 'ux', 'supported', 'case002', 'lowering'),
  feature('template.directive.for-tid', 'ux', 'supported', 'case002', 'lowering'),
  feature('template.event.capture/bubble-control', 'ux', 'rejectedV1', 'negative', 'frontend'),
  feature('script.es-import-export-default', 'script', 'supported', 'case001', 'emitter'),
  feature('script.commonjs-require-literal', 'script', 'supported', 'case001', 'emitter'),
  feature('script.require-context-literal', 'script', 'supported', 'case001', 'emitter'),
  feature('script.global-injection', 'script', 'supported', 'case001', 'emitter'),
  feature('script.object-method/arrow/default-param/template-literal', 'script', 'supported', 'case001', 'emitter'),
  feature('script.promise/prototype-member/for-in', 'script', 'supported', 'case001', 'emitter'),
  feature('style.css-class/descendant-rule', 'style', 'supported', 'case001', 'lowering'),
  feature('style.less-local-import', 'style', 'supported', 'case001', 'lowering'),
  feature('style.less-variable', 'style', 'supported', 'case001', 'lowering'),
  feature('style.less-mixin-declare-call', 'style', 'supported', 'case001', 'lowering'),
  feature('style.less-arithmetic', 'style', 'supported', 'case001', 'lowering'),
  feature('style.less-nested-selector', 'style', 'supported', 'case001', 'lowering'),
  feature('style.css-shorthand', 'style', 'supported', 'case001', 'lowering'),
  feature('template.dynamic-class/style', 'ux', 'rejectedV1', 'negative', 'frontend'),
  feature('template.custom-component/slot', 'ux', 'rejectedV1', 'negative', 'frontend'),
  feature('script.dynamic-import/nonliteral-require', 'script', 'rejectedV1', 'negative', 'frontend'),
  feature('script.package/url-module', 'script', 'rejectedV1', 'negative', 'frontend'),
  feature('style.remote-import/dynamic-path', 'style', 'rejectedV1', 'negative', 'frontend'),
  feature('style.animation/media/custom-property', 'style', 'rejectedV1', 'negative', 'frontend'),
])

function feature(
  featureId: string,
  sourceKind: FrontendFeature['sourceKind'],
  status: FrontendFeature['status'],
  evidence: FrontendFeature['evidence'],
  ownerPhase: FrontendFeature['ownerPhase'],
): FrontendFeature {
  return Object.freeze({ featureId, sourceKind, status, evidence, ownerPhase })
}
