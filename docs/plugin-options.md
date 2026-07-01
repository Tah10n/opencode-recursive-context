# Plugin Options

Plugin options are host-level configuration. They do not read repository config
and do not accept executable callbacks.

## Tool Exposure

`toolset` values:

- `minimal`: `context_outline`, `context_files`, `context_search`,
  `context_read`.
- `advanced`: all tools.
- `all`: alias for all tools.
- `none`: expose no tools.

Default: `minimal`.

`enabledTools` is an explicit allowlist and takes priority over `toolset`.
Unknown tool ids fail plugin initialization. Duplicate ids are deduplicated.

## Host Ceilings

The host can lower these ceilings:

- `maxFiles`
- `maxBytesPerFile`
- `maxTotalBytes`
- `maxTotalLines`
- `maxMatches`
- `maxDurationMs`
- `maxDirectories`
- `maxBatchRanges`
- `maxSymbols`
- `maxRelationships`

Tool arguments can only reduce the effective limit. They cannot raise a host
ceiling or built-in hard maximum.

## Additive Policy Restrictions

The host can add restrictions:

- `additionalIgnoreDirs`
- `additionalSecretNames`
- `additionalSecretExtensions`
- `additionalSecretPathPatterns`

Built-in protections cannot be removed. Secret path patterns are treated as
case-insensitive path substrings, not executable callbacks.

## Example

```js
[
  "opencode-recursive-context",
  {
    toolset: "advanced",
    maxFiles: 1000,
    maxTotalBytes: 10000000,
    additionalIgnoreDirs: ["vendor"],
    additionalSecretPathPatterns: ["private-token"]
  }
]
```
