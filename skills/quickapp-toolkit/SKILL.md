---
name: quickapp-toolkit
description: Use the QuickApp Kit Toolkit to inspect its real CLI contract, compile QuickApp DSL sources, emit Page IR and JS artifacts, and build or validate RPK artifacts through the existing Toolkit APIs and example build scripts.
---

# QuickApp Toolkit

## Scope

Use this Skill when an Agent needs to work with QuickApp Kit source packages,
verify Toolkit behavior, or produce a real RPK from an existing example. The
Toolkit is the single compiler and packaging authority. Do not edit an RPK,
Page IR, generated JS, or runtime metadata by hand to bypass Toolkit checks.

This repository currently exposes a partial standalone CLI contract. The
compiler and RPK builder are implemented as TypeScript library modules and are
used by the checked-in showcase build scripts. The default `dist/cli/bin.js`
process does not install a Build Use Case, so its `build` operation currently
returns `TK_OPERATION_UNAVAILABLE` instead of producing an RPK. `inspect` and
`run` are registered contracts but are also intentionally uninstalled.

## Requirements

- Node.js `>=22`.
- npm.
- Run commands from the Toolkit repository unless a command says otherwise.

Install dependencies and compile the Toolkit:

```sh
cd /Users/qy/code/my-github/quickapp-kit-ai/quickapp-toolkit
npm install
npm run build
```

## Real CLI Contract

The executable entry is `dist/cli/bin.js`; `package.json` also declares the
package binary name `quickapp` pointing to the same file after installation.
The current command registry contains exactly these commands:

| Command | Current behavior | Success state |
| --- | --- | --- |
| `build` | Parses a workspace path and common options, then delegates to the installed Build Use Case. The default standalone process has no Build Use Case and returns `TK_OPERATION_UNAVAILABLE`. | Not available in the default standalone process. |
| `inspect` | Registered reserved operation. | Not available; returns `TK_OPERATION_UNAVAILABLE`. |
| `run` | Registered reserved operation. | Not available; returns `TK_OPERATION_UNAVAILABLE`. |

Top-level options:

```text
--help
--version
```

Common command options:

```text
--config <path>
--format human|json
--no-color
--help
```

The `build` parser accepts zero or one workspace path:

```text
node dist/cli/bin.js build [workspace] [--config <path>] [--format <human|json>] [--no-color]
```

Every command supports command help:

```sh
node dist/cli/bin.js --help
node dist/cli/bin.js build --help
node dist/cli/bin.js inspect --help
node dist/cli/bin.js run --help
node dist/cli/bin.js --version
```

The human renderer writes successful data to stdout and diagnostics to stderr.
`--format json` writes one JSON result envelope to stdout and does not write
human diagnostics to stderr. The result envelope contains `schemaVersion`,
`operation`, `status`, `invocationId`, and either `data` or `failure`.

## Exit Codes

| Code | Meaning |
| ---: | --- |
| `0` | Success, help, or version. |
| `2` | CLI usage error: unknown command, invalid option, missing argument, duplicate option, or invalid format. |
| `3` | Workspace discovery or workspace marker failure. |
| `4` | Configuration failure. |
| `10` | Operation failure, operation unavailable, or non-signal cancellation. |
| `70` | Internal Toolkit or output-rendering failure. |
| `130` | SIGINT cancellation. |
| `143` | SIGTERM cancellation. |

Do not infer success from text output. Require process exit code `0` and, for
JSON output, `status: "success"`.

Useful verified probes:

```sh
node dist/cli/bin.js --help
node dist/cli/bin.js --version
node dist/cli/bin.js inspect sample.rpk --format json
node dist/cli/bin.js unknown --format json
```

The first two return `0`. The reserved `inspect` probe returns `10` with
`TK_OPERATION_UNAVAILABLE`. The unknown command returns `2` with
`TK_CLI_UNKNOWN_COMMAND`.

## Workspace Input

The resolver discovers a workspace from the current directory and its parents,
or accepts one explicit workspace path. A workspace root is marked by either
`quickapp.config.json` or `src/manifest.json`. The resolved source root must
contain `manifest.json`; source, output, and cache roots must remain inside the
workspace and must not overlap.

The compiler input is the source closure reachable from the manifest:

```text
<workspace>/
  quickapp.config.json        optional workspace configuration
  src/
    manifest.json             required public manifest
    app.ux                    optional app module
    pages/<Page>/index.ux     page DSL sources
    helper/**/*.js             reachable shared JS modules
    assets/**/*               reachable local assets and styles
```

The supported source frontend parses the QuickApp `.ux` template, script, and
style sections. The module graph resolves local JS/style/asset references and
checks that capability references are declared in the manifest. The canonical
lowering stage assigns stable template node, block, binding, and handler facts;
the exact generated identifiers are Toolkit output, not inputs for an Agent to
invent.

## Implemented Compiler Pipeline

The implemented library pipeline is:

```text
WorkspaceResolver
  -> SourceAccess and manifest/schema validation
  -> ModuleGraphBuilder
  -> SourceFrontend (.ux template/style/script parsing)
  -> CanonicalLowerer (host components, styles, bindings, if/for blocks, handlers)
  -> JsModuleEmitter (app.js, shared/page index.js, source maps)
  -> PageIrEmitter (quickapp-kit/pages/.../index.ir.json)
  -> RuntimeArtifactBuilder (manifest, runtime metadata, JS, Page IR, resources)
  -> deterministic ZIP/RPK bytes
```

The output semantics currently covered by the tests include:

- template Host nodes and canonical styles;
- `if` and keyed `for` block lowering;
- state bindings and event handlers;
- local styles and style imports;
- page and shared JS module bundles;
- Page IR schema validation;
- runtime metadata and manifest relation validation;
- local PNG/JPEG/octet-stream resource members;
- deterministic member ordering, byte sizes, SHA-256 descriptors, and ZIP limits;
- cancellation and failure paths that do not publish a partial artifact.

`app.js` is the emitted app module. Each page bundle is emitted at
`pages/<manifest-route>/index.js` and carries the QuickApp Kit app-module ABI.
Page IR is emitted at
`quickapp-kit/pages/<manifest-route>/index.ir.json`. The emitted page JS
contains the generated page VM factory, binding evaluators, and handler methods;
the Toolkit does not execute the runtime VM itself.

## RPK Output

`RuntimeArtifactBuilder` produces the `quickapp-kit-rpk-v1` package format. A
real Gallery-001 package currently contains members of these forms:

```text
manifest.json
app.js
pages/pages/<Page>/index.js
quickapp-kit/pages/pages/<Page>/index.ir.json
quickapp-kit/runtime.json
META-INF/quickapp-kit/source-maps/*.map
assets/**
```

The package metadata records `runtimeAbi`, `irVersion`, `jsModuleAbi`, entry
route, page relations, resource descriptors, byte lengths, and SHA-256 values.
Do not assume other files such as `artifact.json`, `templates.bin`,
`BindingId`, or `BlockId` are package members. Identifiers and members must be
read from the generated metadata/IR and validated against the current schemas.

## Producing A Real RPK Today

Until the standalone Build Use Case is installed in the CLI composition root,
use a checked-in showcase build script. This is the current executable
end-to-end path and calls the Toolkit compiler and `RuntimeArtifactBuilder`;
it does not hand-write Page IR or RPK bytes.

```sh
cd /Users/qy/code/my-github/quickapp-kit-ai/quickapp-toolkit
npm run build
node ../quickapp-examples/baseline-cases/capability-gallery-001/scripts/build-capability-gallery.mjs
unzip -t ../quickapp-examples/baseline-cases/capability-gallery-001/dist/capability-gallery-001.rpk
```

The script writes:

```text
../quickapp-examples/baseline-cases/capability-gallery-001/dist/capability-gallery-001.rpk
../quickapp-examples/baseline-cases/capability-gallery-001/dist/capability-gallery-001.json
```

The metadata JSON is the build report. The RPK is the runtime input. `unzip -t`
checks archive integrity; it is not a substitute for the Runtime Loader's
manifest, ABI, capability, and Page IR validation.

## Validation And Diagnostics

Use the existing project checks:

```sh
cd /Users/qy/code/my-github/quickapp-kit-ai/quickapp-toolkit
npm run build
npm test
```

`npm test` currently runs the complete Toolkit test suite, including frontend,
module graph, lowering, emitters, artifact/RPK, application service, CLI,
workspace, diagnostics, observation, cancellation, and determinism tests.
The test runner reports the exact count and exit code; a non-zero exit is a
failure.

The generated RPK should be checked in this order:

1. Require the build script to exit `0` and report `"status": "PASS"`.
2. Read the metadata JSON for package SHA-256, routes, capabilities, and
   resources.
3. Run `unzip -t` for archive integrity.
4. Load the same RPK through the target Runtime Loader for capability preflight,
   Page IR/JS ABI validation, mount, event, navigation, and teardown.

Toolkit diagnostics are structured with severity, code, phase, message, and an
optional source location/hint. Preserve them in Agent reports. Do not replace a
diagnostic with a guessed fallback artifact.

## Common Errors

| Diagnostic/code | Meaning | Action |
| --- | --- | --- |
| `TK_WORKSPACE_NOT_FOUND` | No workspace marker was found from the current directory. | Run from the workspace or pass its explicit path to `build`. |
| `TK_WORKSPACE_MARKER_MISSING` | The explicit root, source directory, or manifest is missing. | Check `src/manifest.json` and the workspace root marker. |
| `TK_OPERATION_UNAVAILABLE` | The selected CLI operation has no installed use case in the current composition root. | Do not retry as though it were a compiler error; use the checked-in build script or install the operation in a separate, explicitly scoped composition root. |
| `TK_CLI_UNKNOWN_COMMAND` | The command is not registered. | Use `node dist/cli/bin.js --help`; do not invent subcommands. |
| capability, schema, lowering, artifact, or asset diagnostics | The source closure or generated relation is invalid. | Fix the source/manifest through Toolkit input, then rebuild. Do not patch the RPK. |

## Agent Rules

- Treat the RPK generated by Toolkit as the only runtime package input.
- Keep app source, manifest, and assets in the workspace source closure.
- Use the current CLI/API contracts and schemas; do not infer undocumented
  artifact members or identifiers.
- Do not directly unzip, edit, repack, or patch an RPK to make validation pass.
- Do not copy Toolkit compiler logic into a runtime, simulator, or Agent script.
- If a requested command is not installed, report the exact diagnostic and stop
  at that boundary instead of silently implementing a second build path.
