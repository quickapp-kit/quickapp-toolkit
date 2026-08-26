# QuickApp Toolkit

CLI and build toolchain for [QuickApp Kit](https://github.com/quickapp-kit). Handles workspace resolution, compilation, inspection, and runtime invocation.

## What it does

```
quickapp build    → compile .ux → Page IR → RPK bundle
quickapp inspect  → static analysis, dependency graph, diagnostics
quickapp run      → launch RPK in a local runtime
```

Currently implemented (TK-S01):
- CLI command registration (`build`, `inspect`, `run`)
- Standard `SKILL.md` capability for any AI Agent to discover and call the Toolkit workflow
- Workspace discovery and `quickapp.config.json` resolution
- Bounded `SourceAccess` with path containment and change detection
- Compiler frontend: UX/template/style/script parsing → Page IR model
- Structured Result/Diagnostic output (human + JSON), exit codes, cancellation
- Build observation markers

Not yet:
- Full bundle generation, runtime artifact packaging
- `inspect` / `run` business logic
- MCP integration, runtime tracing

## Requirements

- Node.js >= 22
- npm

## Usage

```bash
npm install
npm run build
node dist/cli/bin.js --help
```

## Development

```bash
npm run typecheck    # Type check
npm run lint         # Boundary check
npm test             # All tests
npm run test:cli     # CLI integration tests
```

## Project Structure

```
├── src/
│   ├── cli/            # CLI entry, command dispatch
│   ├── application/    # Application service layer
│   ├── compiler/       # UX → Page IR compiler
│   ├── workspace/      # Workspace discovery, config resolution
│   ├── diagnostics/    # Structured errors and warnings
│   ├── observation/    # Build markers, observation ports
│   └── types/          # Shared type definitions
├── test/               # Unit + integration tests
├── scripts/            # Build & check scripts
└── evidence/           # TK-S01 verification
```

## Related

- [quickapp-runtime-core](https://github.com/quickapp-kit/quickapp-runtime-core) — C++ runtime kernel
- [quickapp-runtime-lvgl](https://github.com/quickapp-kit/quickapp-runtime-lvgl) — LVGL adapter
- [quickapp-runtime-android](https://github.com/quickapp-kit/quickapp-runtime-android) — Android adapter

## License

[MIT](LICENSE)
