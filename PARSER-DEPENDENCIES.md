# Parser Dependencies

## Conclusion

TK-S02/TK-S03 use fixed, syntax-only parser dependencies. Target resolution remains in S02; Lowering and Artifact generation are out of scope.

| Boundary | Package | Version | License | Use |
|---|---|---:|---|---|
| JSON CST | `jsonc-parser` | `3.3.1` | MIT | Strict Manifest CST, offsets and duplicate-key detection |
| UX/HTML | `parse5` | `8.0.1` | MIT | Structured UX fragment/template parsing with source locations |
| JavaScript | `acorn` | `8.18.0` | MIT | ESTree-compatible Program and expression parsing |
| CSS | `postcss` | `8.5.26` | MIT | CSS syntax tree and source locations |
| Less | `postcss-less` | `6.0.0` | MIT | Less syntax adapter for PostCSS |

Versions are exact in `package.json` and `package-lock.json`. A parser upgrade requires all Case, position, deterministic and negative Golden tests to pass again.
