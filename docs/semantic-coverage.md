# Semantic Coverage

`context_symbols` and `context_related` are heuristic orientation tools. They
are not language servers, AST parsers, dependency solvers, or call graphs.

## Symbols

`context_symbols` supports TypeScript, JavaScript, Python, and Java through
bounded regex extractors. Each symbol includes:

- `path`
- `line`
- `language`
- `kind`
- `name`
- bounded `signature`
- `confidence`
- `extractor`
- optional `sourceSha256`

The result reports supported languages, unsupported-language counts, parse or
read gaps through coverage, symbol limits, and partial coverage.

## Related Files

`context_related` returns related entries with:

- `path`
- `relationship`
- `evidence`
- `confidence`
- `language`
- optional `sourceSha256`

Confidence values:

- `high`: resolved relative import or imported-by through a parsed relative
  import.
- `medium`: likely test by naming.
- `low`: same basename or sibling.

Supported relation kinds:

- `direct-import`
- `imported-by`
- `likely-test`
- `same-basename`
- `sibling`

Unsupported mechanisms include dynamic dependency injection, reflection,
runtime routing, generated bindings, framework registries, database triggers,
RPC service discovery, non-relative alias resolution, and cross-language links.

No related graph or import index is stored between calls.
