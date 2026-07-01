import { createHash } from "node:crypto"
import * as nodeFs from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { TextDecoder } from "node:util"
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const SCHEMA_VERSION = 2
const WORKTREE_DISPLAY = "."

const ALL_TOOL_IDS = [
  "context_outline",
  "context_files",
  "context_search",
  "context_read",
  "context_map",
  "context_batch_read",
  "context_symbols",
  "context_related",
] as const
type ToolId = (typeof ALL_TOOL_IDS)[number]

const TOOLSETS: Record<string, ToolId[]> = {
  minimal: ["context_outline", "context_files", "context_search", "context_read"],
  advanced: [...ALL_TOOL_IDS],
  all: [...ALL_TOOL_IDS],
  none: [],
}

const BUILTIN_IGNORE_DIRS = [
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".gradle",
  ".oc_learning",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".idea",
  ".vscode",
  "Pods",
]

const BUILTIN_SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube"]
const BUILTIN_SECRET_FILENAMES = [
  ".env",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.ini",
  "credentials.json",
  "credentials.toml",
  "credentials.yaml",
  "credentials.yml",
  "gradle.properties",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "local.properties",
  "nuget.config",
  "pip.conf",
  "secrets.json",
  "secrets.toml",
  "secrets.yaml",
  "secrets.yml",
  "settings-security.xml",
  "settings.xml",
]
const BUILTIN_SECRET_EXTENSIONS = [".key", ".keystore", ".jks", ".p8", ".p12", ".pem", ".pfx", ".kdbx"]
const BUILTIN_SECRET_NAME_PATTERNS = [
  /^credentials\.(cfg|conf|ini|json|toml|txt|ya?ml)$/i,
  /^secrets?\.(cfg|conf|ini|json|toml|txt|ya?ml)$/i,
  /(^|[-_.])private[-_.]?key($|[-_.])/i,
  /(^|[-_.])service[-_.]?account($|[-_.])/i,
]

const HARD_LIMITS = {
  maxFiles: 5_000,
  maxBytesPerFile: 5_000_000,
  maxTotalBytes: 40_000_000,
  maxTotalLines: 40_000,
  maxMatches: 500,
  maxDurationMs: 30_000,
  maxDirectories: 5_000,
  maxBatchRanges: 20,
  maxSymbols: 1_000,
  maxRelationships: 300,
}

const DEFAULT_LIMITS = {
  maxFiles: 500,
  maxBytesPerFile: 1_500_000,
  maxTotalBytes: 20_000_000,
  maxTotalLines: 12_000,
  maxMatches: 100,
  maxDurationMs: 10_000,
  maxDirectories: 2_000,
  maxBatchRanges: 20,
  maxSymbols: 200,
  maxRelationships: 80,
}

const DEFAULT_MAX_MATCH_TEXT_CHARS = 320
const DEFAULT_BATCH_TOTAL_LINES = 1_200

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  [".cjs", "javascript"],
  [".css", "css"],
  [".go", "go"],
  [".java", "java"],
  [".js", "javascript"],
  [".json", "json"],
  [".jsx", "javascript"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".md", "markdown"],
  [".mjs", "javascript"],
  [".py", "python"],
  [".rs", "rust"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".tsx", "typescript"],
  [".ts", "typescript"],
  [".xml", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
])
const SYMBOL_LANGUAGES = new Set(["javascript", "typescript", "python", "java"])
const IMPORT_LANGUAGES = new Set(["javascript", "typescript"])
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"])
const CONFIG_EXTENSIONS = new Set([".conf", ".config", ".ini", ".json", ".toml", ".xml", ".yaml", ".yml"])
const MANIFEST_FILENAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "composer.json",
  "dockerfile",
  "gemfile",
  "go.mod",
  "package.json",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "settings.gradle.kts",
])
const CONFIG_FILENAMES = new Set([
  ".editorconfig",
  ".eslintignore",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".prettierrc",
  "eslint.config.js",
  "tsconfig.json",
])
const CI_FILENAMES = new Set([".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml"])
const TEST_SEGMENTS = new Set(["__tests__", "spec", "specs", "test", "tests"])
const RELATED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]
const RELATED_UNSUPPORTED_MECHANISMS = [
  "dynamic dependency injection",
  "reflection",
  "runtime routing",
  "generated bindings",
  "framework registries",
  "database triggers",
  "RPC service discovery",
  "non-relative alias resolution",
  "cross-language links",
]

const TRUNCATION_FLAG_KEYS = [
  "inventoryLimitReached",
  "resultLimitReached",
  "matchLimitReached",
  "byteLimitReached",
  "lineLimitReached",
  "durationLimitReached",
  "excerptTruncated",
  "contextBeforeTruncated",
  "contextAfterTruncated",
  "symbolLimitReached",
  "relationshipLimitReached",
  "snapshotChanged",
  "coveragePartial",
] as const
type TruncationFlagKey = (typeof TRUNCATION_FLAG_KEYS)[number]
type TruncationFlags = Record<TruncationFlagKey, boolean>

const COVERAGE_PARTIAL_TRUNCATION_FLAGS = new Set<TruncationFlagKey>([
  "inventoryLimitReached",
  "resultLimitReached",
  "matchLimitReached",
  "byteLimitReached",
  "lineLimitReached",
  "durationLimitReached",
  "symbolLimitReached",
  "relationshipLimitReached",
  "snapshotChanged",
])

type FileRole = "ci" | "config" | "doc" | "manifest" | "other" | "source" | "test"

type FileEntry = {
  path: string
  size: number
  language: string
  role: FileRole
}

type SymbolEntry = {
  path: string
  line: number
  language: string
  kind: "class" | "constant" | "enum" | "function" | "interface" | "method" | "record" | "type"
  name: string
  signature?: string
  confidence: "medium"
  extractor: string
  sourceSha256?: string
}

type RelatedEntry = {
  path: string
  relationship: "direct-import" | "imported-by" | "likely-test" | "same-basename" | "sibling"
  evidence: string
  confidence: "high" | "medium" | "low"
  language: string
  sourceSha256?: string
}

type MetadataEntry = {
  path: string
  type: "directory" | "file"
  size: number
  mtime: string
  dev?: string
  ino?: string
}

type ReadFileResult = {
  displayPath: string
  text: string
  bytes: number
  totalLines: number
  encoding: "utf-8" | "utf-8-bom"
  sha256: string
  stableDuringRead: boolean
  metadataBefore: MetadataEntry
  metadataAfter: MetadataEntry
}

type Coverage = {
  candidateFiles: number
  scannedFiles: number
  bytesScanned: number
  skippedSecret: number
  skippedGenerated: number
  skippedLarge: number
  skippedUnreadable: number
  unsupportedLanguages: Record<string, number>
  truncation: TruncationFlags
  truncationReasons: string[]
  partial: boolean
}

type Snapshot = {
  fingerprint: string
  fingerprintKind: "metadata" | "content" | "partial-content"
  fingerprintScope: string
  complete: boolean
  stable: boolean
  changedDuringOperation: boolean
  beforeFingerprint?: string
  afterFingerprint?: string
  truncationReasons: string[]
}

type AppliedLimits = typeof HARD_LIMITS

type Operation = {
  signal?: AbortSignal
  startedAt: number
  deadlineAt: number
  limits: AppliedLimits
  usage: {
    files: number
    directories: number
    bytes: number
    lines: number
    matches: number
    ranges: number
  }
}

type Policy = {
  ignoreDirs: Set<string>
  secretDirs: Set<string>
  secretNames: Set<string>
  secretExtensions: Set<string>
  secretNamePatterns: RegExp[]
  secretPathPatterns: string[]
}

type PluginConfig = {
  enabledToolIds: ToolId[]
  policy: Policy
  ceilings: AppliedLimits
  toolset: string
  explicitEnabledTools: boolean
}

type WalkResult = {
  files: Array<{ path: string; size: number; metadata: MetadataEntry }>
  metadata: MetadataEntry[]
  coverage: Coverage
  truncated: boolean
}

type WalkOptions = {
  maxFiles: number
  contains?: string
  includeFile?: (displayPath: string) => boolean
}

class AbortOperationError extends Error {
  constructor() {
    super("Operation aborted")
    this.name = "AbortError"
  }
}

class DeadlineExceededError extends Error {
  constructor() {
    super("deadline-exceeded")
    this.name = "DeadlineExceededError"
  }
}

class ByteLimitExceededError extends Error {
  readonly limit: "maxBytesPerFile" | "maxTotalBytes"

  constructor(limit: "maxBytesPerFile" | "maxTotalBytes", message?: string) {
    super(message || `${limit}-exceeded`)
    this.name = "ByteLimitExceededError"
    this.limit = limit
  }
}

class HashMismatchError extends Error {
  readonly actualSha256: string
  readonly expectedSha256: string
  readonly displayPath: string

  constructor(displayPath: string, expectedSha256: string, actualSha256: string) {
    super("hash-mismatch")
    this.name = "HashMismatchError"
    this.displayPath = displayPath
    this.expectedSha256 = expectedSha256
    this.actualSha256 = actualSha256
  }
}

function emptyTruncationFlags(): TruncationFlags {
  return {
    inventoryLimitReached: false,
    resultLimitReached: false,
    matchLimitReached: false,
    byteLimitReached: false,
    lineLimitReached: false,
    durationLimitReached: false,
    excerptTruncated: false,
    contextBeforeTruncated: false,
    contextAfterTruncated: false,
    symbolLimitReached: false,
    relationshipLimitReached: false,
    snapshotChanged: false,
    coveragePartial: false,
  }
}

function emptyCoverage(): Coverage {
  return {
    candidateFiles: 0,
    scannedFiles: 0,
    bytesScanned: 0,
    skippedSecret: 0,
    skippedGenerated: 0,
    skippedLarge: 0,
    skippedUnreadable: 0,
    unsupportedLanguages: {},
    truncation: emptyTruncationFlags(),
    truncationReasons: [],
    partial: false,
  }
}

function markTruncation(coverage: Coverage, flag: TruncationFlagKey, reason?: string): void {
  coverage.truncation[flag] = true
  if (COVERAGE_PARTIAL_TRUNCATION_FLAGS.has(flag)) {
    coverage.partial = true
    coverage.truncation.coveragePartial = true
  }
  if (reason && !coverage.truncationReasons.includes(reason)) coverage.truncationReasons.push(reason)
}

function finalizeCoverage(coverage: Coverage): Coverage {
  const hasTruncation = [...COVERAGE_PARTIAL_TRUNCATION_FLAGS].some((key) => coverage.truncation[key])
  coverage.partial = coverage.skippedLarge > 0 || coverage.skippedUnreadable > 0 || hasTruncation
  coverage.truncation.coveragePartial = coverage.partial
  coverage.truncationReasons = [...new Set(coverage.truncationReasons)].sort()
  return coverage
}

function mergeCoverage(target: Coverage, source: Coverage): Coverage {
  target.candidateFiles += source.candidateFiles
  target.scannedFiles += source.scannedFiles
  target.bytesScanned += source.bytesScanned
  target.skippedSecret += source.skippedSecret
  target.skippedGenerated += source.skippedGenerated
  target.skippedLarge += source.skippedLarge
  target.skippedUnreadable += source.skippedUnreadable
  for (const [language, count] of Object.entries(source.unsupportedLanguages)) {
    target.unsupportedLanguages[language] = (target.unsupportedLanguages[language] || 0) + count
  }
  for (const key of TRUNCATION_FLAG_KEYS) {
    if (source.truncation[key]) target.truncation[key] = true
  }
  target.truncationReasons.push(...source.truncationReasons)
  return finalizeCoverage(target)
}

function isAbortError(error: unknown): boolean {
  return error instanceof AbortOperationError || (error instanceof Error && error.name === "AbortError")
}

function markReadFailure(coverage: Coverage, error: unknown): void {
  if (error instanceof ByteLimitExceededError) {
    markTruncation(coverage, "byteLimitReached", error.limit)
    return
  }
  coverage.skippedUnreadable++
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortOperationError()
}

function checkOperation(operation: Operation): void {
  checkAbort(operation.signal)
  if (performance.now() > operation.deadlineAt) {
    throw new DeadlineExceededError()
  }
}

function asStringArray(value: unknown, name: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be an array of strings`)
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))]
}

function optionLimit(options: PluginOptions | undefined, name: keyof AppliedLimits): number {
  const value = options?.[name]
  if (!Number.isFinite(value)) return HARD_LIMITS[name]
  return Math.max(1, Math.min(HARD_LIMITS[name], Math.trunc(value as number)))
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.max(min, Math.min(max, fallback))
  return Math.max(min, Math.min(max, Math.trunc(value as number)))
}

function limitValue(value: number | undefined, fallback: number, min: number, ceiling: number): number {
  return clampInt(value, Math.min(fallback, ceiling), min, ceiling)
}

function parsePluginConfig(options?: PluginOptions): PluginConfig {
  const toolset = typeof options?.toolset === "string" ? options.toolset : "minimal"
  if (!Object.hasOwn(TOOLSETS, toolset)) {
    throw new Error(`Unknown toolset: ${toolset}`)
  }

  const requestedTools = options?.enabledTools
  const explicitEnabledTools = requestedTools != null
  const enabledToolIds = explicitEnabledTools
    ? asStringArray(requestedTools, "enabledTools").map((id) => {
        if (!ALL_TOOL_IDS.includes(id as ToolId)) throw new Error(`Unknown tool id in enabledTools: ${id}`)
        return id as ToolId
      })
    : TOOLSETS[toolset]

  return {
    enabledToolIds: ALL_TOOL_IDS.filter((id) => enabledToolIds.includes(id)),
    explicitEnabledTools,
    toolset,
    ceilings: {
      maxFiles: optionLimit(options, "maxFiles"),
      maxBytesPerFile: optionLimit(options, "maxBytesPerFile"),
      maxTotalBytes: optionLimit(options, "maxTotalBytes"),
      maxTotalLines: optionLimit(options, "maxTotalLines"),
      maxMatches: optionLimit(options, "maxMatches"),
      maxDurationMs: optionLimit(options, "maxDurationMs"),
      maxDirectories: optionLimit(options, "maxDirectories"),
      maxBatchRanges: optionLimit(options, "maxBatchRanges"),
      maxSymbols: optionLimit(options, "maxSymbols"),
      maxRelationships: optionLimit(options, "maxRelationships"),
    },
    policy: {
      ignoreDirs: new Set([...BUILTIN_IGNORE_DIRS, ...asStringArray(options?.additionalIgnoreDirs, "additionalIgnoreDirs")].map((entry) => entry.toLowerCase())),
      secretDirs: new Set(BUILTIN_SECRET_DIRS),
      secretNames: new Set([...BUILTIN_SECRET_FILENAMES, ...asStringArray(options?.additionalSecretNames, "additionalSecretNames")].map((entry) => entry.toLowerCase())),
      secretExtensions: new Set([...BUILTIN_SECRET_EXTENSIONS, ...asStringArray(options?.additionalSecretExtensions, "additionalSecretExtensions")].map(normalizeExtension)),
      secretNamePatterns: BUILTIN_SECRET_NAME_PATTERNS,
      secretPathPatterns: asStringArray(options?.additionalSecretPathPatterns, "additionalSecretPathPatterns").map((entry) => entry.toLowerCase()),
    },
  }
}

function operation(context: { abort?: AbortSignal }, config: PluginConfig, requested: Partial<AppliedLimits>): Operation {
  const limits: AppliedLimits = {
    maxFiles: Math.min(requested.maxFiles ?? DEFAULT_LIMITS.maxFiles, config.ceilings.maxFiles),
    maxBytesPerFile: Math.min(requested.maxBytesPerFile ?? DEFAULT_LIMITS.maxBytesPerFile, config.ceilings.maxBytesPerFile),
    maxTotalBytes: Math.min(requested.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes, config.ceilings.maxTotalBytes),
    maxTotalLines: Math.min(requested.maxTotalLines ?? DEFAULT_LIMITS.maxTotalLines, config.ceilings.maxTotalLines),
    maxMatches: Math.min(requested.maxMatches ?? DEFAULT_LIMITS.maxMatches, config.ceilings.maxMatches),
    maxDurationMs: Math.min(requested.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs, config.ceilings.maxDurationMs),
    maxDirectories: Math.min(requested.maxDirectories ?? DEFAULT_LIMITS.maxDirectories, config.ceilings.maxDirectories),
    maxBatchRanges: Math.min(requested.maxBatchRanges ?? DEFAULT_LIMITS.maxBatchRanges, config.ceilings.maxBatchRanges),
    maxSymbols: Math.min(requested.maxSymbols ?? DEFAULT_LIMITS.maxSymbols, config.ceilings.maxSymbols),
    maxRelationships: Math.min(requested.maxRelationships ?? DEFAULT_LIMITS.maxRelationships, config.ceilings.maxRelationships),
  }
  const startedAt = performance.now()
  const current: Operation = {
    signal: context.abort,
    startedAt,
    deadlineAt: startedAt + limits.maxDurationMs,
    limits,
    usage: { files: 0, directories: 0, bytes: 0, lines: 0, matches: 0, ranges: 0 },
  }
  checkOperation(current)
  return current
}

async function projectRoot(context: { worktree?: string; directory: string }, signal?: AbortSignal): Promise<string> {
  checkAbort(signal)
  return await fs.realpath(path.resolve(context.worktree || context.directory))
}

function toDisplayPath(root: string, absolutePath: string): string {
  const rel = path.relative(root, absolutePath)
  return rel ? rel.split(path.sep).join("/") : WORKTREE_DISPLAY
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/")
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
}

function safeRequestedPath(requestedPath: string | undefined): string {
  if (!requestedPath) return WORKTREE_DISPLAY
  if (path.isAbsolute(requestedPath)) return "<absolute>"
  return toPosixPath(requestedPath)
}

function resolveInside(root: string, requestedPath: string | undefined): string {
  if (requestedPath && path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed; use a relative path")
  }
  const target = path.resolve(root, requestedPath || WORKTREE_DISPLAY)
  if (!isInside(root, target)) {
    throw new Error(`Path is outside the worktree: ${safeRequestedPath(requestedPath)}`)
  }
  return target
}

async function safeRealPath(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target)
  } catch {
    return null
  }
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase()
  if (!trimmed) return ""
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`
}

function basenameOf(displayPath: string): string {
  return displayPath.split("/").pop() || displayPath
}

function dirnameOf(displayPath: string): string {
  const index = displayPath.lastIndexOf("/")
  return index >= 0 ? displayPath.slice(0, index) : WORKTREE_DISPLAY
}

function stemOf(displayPath: string): string {
  const basename = basenameOf(displayPath)
  const extension = path.posix.extname(basename)
  return extension ? basename.slice(0, -extension.length) : basename
}

function languageForPath(displayPath: string): string {
  const basename = basenameOf(displayPath).toLowerCase()
  if (basename === "dockerfile") return "dockerfile"
  return LANGUAGE_BY_EXTENSION.get(path.posix.extname(basename)) || "unknown"
}

function isSecretName(name: string, policy: Policy): boolean {
  const lower = name.toLowerCase()
  if (policy.secretDirs.has(lower)) return true
  if (policy.secretNames.has(lower)) return true
  if (lower.startsWith(".env.") && lower !== ".env.example") return true
  if (policy.secretNamePatterns.some((pattern) => pattern.test(name))) return true
  return policy.secretExtensions.has(path.extname(lower))
}

function hasSecretSegment(displayPath: string, policy: Policy): boolean {
  const lower = displayPath.toLowerCase()
  return displayPath.split("/").some((segment) => isSecretName(segment, policy)) || policy.secretPathPatterns.some((pattern) => lower.includes(pattern))
}

function hasIgnoredDirectorySegment(displayPath: string, policy: Policy): boolean {
  const directory = dirnameOf(displayPath)
  if (directory === WORKTREE_DISPLAY) return false
  return directory.split("/").some((segment) => policy.ignoreDirs.has(segment.toLowerCase()))
}

function shouldSkipDirectory(name: string, policy: Policy): "generated" | "secret" | null {
  const lower = name.toLowerCase()
  if (policy.secretDirs.has(lower) || isSecretName(name, policy)) return "secret"
  if (policy.ignoreDirs.has(lower)) return "generated"
  return null
}

function classifyPath(displayPath: string, policy: Policy): "generated" | "secret" | null {
  if (hasSecretSegment(displayPath, policy)) return "secret"
  if (hasIgnoredDirectorySegment(displayPath, policy)) return "generated"
  return null
}

async function resolveExistingInside(root: string, requestedPath: string | undefined, policy: Policy, operation?: Operation): Promise<string | null> {
  if (operation) checkOperation(operation)
  const target = resolveInside(root, requestedPath)
  const requestedDisplayPath = toDisplayPath(root, target)
  const requestedClassification = classifyPath(requestedDisplayPath, policy)
  if (requestedClassification === "secret") throw new Error(`Refusing secret-like path: ${requestedDisplayPath}`)
  if (requestedClassification === "generated") throw new Error(`Refusing generated/dependency/cache path: ${requestedDisplayPath}`)

  const realTarget = await safeRealPath(target)
  if (!realTarget) return null
  if (!isInside(root, realTarget)) {
    throw new Error(`Path resolves outside the worktree: ${safeRequestedPath(requestedPath)}`)
  }
  const realDisplayPath = toDisplayPath(root, realTarget)
  const realClassification = classifyPath(realDisplayPath, policy)
  if (realClassification === "secret") throw new Error(`Refusing secret-like path: ${realDisplayPath}`)
  if (realClassification === "generated") throw new Error(`Refusing generated/dependency/cache path: ${realDisplayPath}`)
  return realTarget
}

async function safeLstat(target: string, operation?: Operation): Promise<nodeFs.Stats | null> {
  try {
    if (operation) checkOperation(operation)
    return await fs.lstat(target)
  } catch (error) {
    if (isAbortError(error) || error instanceof DeadlineExceededError) throw error
    return null
  }
}

function metadataFromStat(root: string, absolutePath: string, stat: nodeFs.Stats, type: "directory" | "file"): MetadataEntry {
  const statLike = stat as nodeFs.Stats & { mtimeNs?: bigint }
  return {
    path: toDisplayPath(root, absolutePath),
    type,
    size: type === "file" ? stat.size : 0,
    mtime: statLike.mtimeNs ? statLike.mtimeNs.toString() : stat.mtimeMs.toFixed(3),
    dev: Number.isFinite(stat.dev) ? String(stat.dev) : undefined,
    ino: Number.isFinite(stat.ino) ? String(stat.ino) : undefined,
  }
}

function sameMetadata(left: MetadataEntry, right: MetadataEntry): boolean {
  return left.type === right.type && left.size === right.size && left.mtime === right.mtime && left.dev === right.dev && left.ino === right.ino
}

function sha256Buffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function sha256Parts(parts: string[]): string {
  const hash = createHash("sha256")
  for (const part of parts) {
    hash.update(part)
    hash.update("\0")
  }
  return hash.digest("hex")
}

function metadataFingerprint(entries: MetadataEntry[]): string {
  return sha256Parts(
    entries
      .map((entry) => `${entry.path}\t${entry.type}\t${entry.size}\t${entry.mtime}\t${entry.dev || ""}\t${entry.ino || ""}`)
      .sort(),
  )
}

function contentFingerprint(entries: Array<{ path: string; sha256: string; range?: string }>): string {
  return sha256Parts(entries.map((entry) => `${entry.path}\t${entry.sha256}\t${entry.range || ""}`).sort())
}

function snapshotFromMetadata(scope: string, metadata: MetadataEntry[], coverage: Coverage): Snapshot {
  const complete = !finalizeCoverage(coverage).partial
  return {
    fingerprint: metadataFingerprint(metadata),
    fingerprintKind: "metadata",
    fingerprintScope: scope,
    complete,
    stable: true,
    changedDuringOperation: false,
    truncationReasons: [...coverage.truncationReasons],
  }
}

function snapshotFromContent(scope: string, entries: Array<{ path: string; sha256: string; range?: string }>, coverage: Coverage): Snapshot {
  const complete = !finalizeCoverage(coverage).partial
  return {
    fingerprint: contentFingerprint(entries),
    fingerprintKind: complete ? "content" : "partial-content",
    fingerprintScope: scope,
    complete,
    stable: true,
    changedDuringOperation: false,
    truncationReasons: [...coverage.truncationReasons],
  }
}

function jsonEnvelope(
  toolId: ToolId,
  scope: Record<string, unknown>,
  snapshot: Snapshot,
  coverage: Coverage,
  operation: Operation,
  result: Record<string, unknown>,
): string {
  const finalized = finalizeCoverage(coverage)
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      tool: toolId,
      worktree: WORKTREE_DISPLAY,
      scope,
      snapshot,
      coverage: finalized,
      limits: operation.limits,
      usage: operation.usage,
      truncated: finalized.partial,
      ...result,
    },
    null,
    2,
  )
}

function deadlineFailure(toolId: ToolId, scope: Record<string, unknown>, coverage: Coverage, operation: Operation): string {
  markTruncation(coverage, "durationLimitReached", "deadline-exceeded")
  const snapshot = snapshotFromMetadata(String(scope.path || WORKTREE_DISPLAY), [], coverage)
  return jsonEnvelope(toolId, scope, snapshot, coverage, operation, {
    ok: false,
    error: "deadline-exceeded",
  })
}

async function walkFiles(
  root: string,
  startPath: string,
  policy: Policy,
  operation: Operation,
  options: WalkOptions,
): Promise<WalkResult> {
  const files: WalkResult["files"] = []
  const metadata: MetadataEntry[] = []
  const coverage = emptyCoverage()
  const stack = [startPath]
  const containsLower = options.contains?.toLowerCase()
  let truncated = false

  while (stack.length > 0) {
    checkOperation(operation)
    const current = stack.pop() as string
    const displayPath = toDisplayPath(root, current)
    const classification = classifyPath(displayPath, policy)
    if (classification === "secret") {
      coverage.skippedSecret++
      continue
    }
    if (classification === "generated") {
      coverage.skippedGenerated++
      continue
    }

    const stat = await safeLstat(current, operation)
    if (!stat) {
      coverage.skippedUnreadable++
      continue
    }

    if (stat.isSymbolicLink()) {
      coverage.skippedUnreadable++
      continue
    }

    const realCurrent = await safeRealPath(current)
    if (!realCurrent || !isInside(root, realCurrent)) {
      coverage.skippedUnreadable++
      continue
    }

    if (stat.isDirectory()) {
      const dirPolicy = shouldSkipDirectory(path.basename(current), policy)
      if (dirPolicy === "secret") {
        coverage.skippedSecret++
        continue
      }
      if (dirPolicy === "generated") {
        coverage.skippedGenerated++
        continue
      }

      operation.usage.directories++
      if (operation.usage.directories > operation.limits.maxDirectories) {
        truncated = true
        markTruncation(coverage, "inventoryLimitReached", "maxDirectories")
        break
      }
      metadata.push(metadataFromStat(root, current, stat, "directory"))

      let entries: string[]
      try {
        checkOperation(operation)
        entries = await fs.readdir(current)
      } catch (error) {
        if (isAbortError(error) || error instanceof DeadlineExceededError) throw error
        coverage.skippedUnreadable++
        continue
      }

      for (const entry of entries.sort().reverse()) {
        stack.push(path.join(current, entry))
      }
      continue
    }

    if (!stat.isFile()) continue
    if (containsLower && !displayPath.toLowerCase().includes(containsLower)) continue
    if (options.includeFile && !options.includeFile(displayPath)) continue

    coverage.candidateFiles++
    const fileMetadata = metadataFromStat(root, current, stat, "file")
    metadata.push(fileMetadata)
    if (files.length >= options.maxFiles) {
      truncated = true
      markTruncation(coverage, "inventoryLimitReached", "maxFiles")
      break
    }
    files.push({ path: displayPath, size: stat.size, metadata: fileMetadata })
    operation.usage.files++
  }

  return { files: files.sort((left, right) => left.path.localeCompare(right.path)), metadata, coverage: finalizeCoverage(coverage), truncated }
}

async function openReadOnlyNoFollow(target: string): Promise<fs.FileHandle> {
  const noFollow = typeof nodeFs.constants.O_NOFOLLOW === "number" ? nodeFs.constants.O_NOFOLLOW : 0
  const flags = nodeFs.constants.O_RDONLY | noFollow
  try {
    return await fs.open(target, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (noFollow && ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code || "")) {
      return await fs.open(target, nodeFs.constants.O_RDONLY)
    }
    throw error
  }
}

function decodeUtf8(bytes: Buffer, displayPath: string): { text: string; encoding: "utf-8" | "utf-8-bom" } {
  if (bytes.includes(0)) throw new Error(`Refusing to read binary-like file: ${displayPath}`)

  let controlCount = 0
  for (const byte of bytes) {
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controlCount++
  }
  if (controlCount > 8 && controlCount / Math.max(1, bytes.length) > 0.05) {
    throw new Error(`Refusing to read control-heavy binary-like file: ${displayPath}`)
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    const encoding = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8-bom" : "utf-8"
    return { text, encoding }
  } catch {
    throw new Error(`Refusing malformed UTF-8 file: ${displayPath}`)
  }
}

async function readBoundedFile(handle: fs.FileHandle, maxBytes: number, operation: Operation): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < maxBytes) {
    checkOperation(operation)
    const remaining = maxBytes - total
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
    if (bytesRead === 0) break
    chunks.push(buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  return Buffer.concat(chunks, total)
}

async function readRawStableFile(root: string, absolutePath: string, maxBytes: number, operation: Operation): Promise<{
  bytes: Buffer
  metadataBefore: MetadataEntry
  metadataAfter: MetadataEntry
  stableDuringRead: boolean
}> {
  let handle: fs.FileHandle | undefined
  try {
    checkOperation(operation)
    handle = await openReadOnlyNoFollow(absolutePath)
    const before = await handle.stat()
    const displayBefore = metadataFromStat(root, absolutePath, before, "file")
    if (!before.isFile()) throw new Error(`Not a readable file: ${displayBefore.path}`)
    if (before.size > maxBytes) throw new ByteLimitExceededError("maxBytesPerFile", `maxBytesPerFile: File is too large for this safe reader: ${displayBefore.path} (${before.size} bytes)`)
    const remainingTotalBytes = operation.limits.maxTotalBytes - operation.usage.bytes
    if (before.size > remainingTotalBytes) {
      throw new ByteLimitExceededError("maxTotalBytes")
    }
    const readLimit = Math.min(maxBytes, remainingTotalBytes)
    const bytes = await readBoundedFile(handle, readLimit, operation)
    operation.usage.bytes += bytes.length
    if (operation.usage.bytes > operation.limits.maxTotalBytes) {
      throw new ByteLimitExceededError("maxTotalBytes")
    }
    const after = await handle.stat()
    const displayAfter = metadataFromStat(root, absolutePath, after, "file")
    return {
      bytes,
      metadataBefore: displayBefore,
      metadataAfter: displayAfter,
      stableDuringRead: sameMetadata(displayBefore, displayAfter) && bytes.length === before.size,
    }
  } finally {
    await handle?.close()
  }
}

async function readTextFile(
  root: string,
  requestedPath: string,
  policy: Policy,
  operation: Operation,
  options: { expectedSha256?: string; maxBytesPerFile?: number } = {},
): Promise<ReadFileResult> {
  checkOperation(operation)
  const absolutePath = await resolveExistingInside(root, requestedPath, policy, operation)
  if (!absolutePath) throw new Error(`Not a readable file: ${safeRequestedPath(requestedPath)}`)

  const displayPath = toDisplayPath(root, absolutePath)
  const maxBytes = Math.min(options.maxBytesPerFile ?? operation.limits.maxBytesPerFile, operation.limits.maxBytesPerFile)

  let read = await readRawStableFile(root, absolutePath, maxBytes, operation)
  if (!read.stableDuringRead) {
    read = await readRawStableFile(root, absolutePath, maxBytes, operation)
    if (!read.stableDuringRead) throw new Error(`unstable-read: ${displayPath}`)
  }

  const sha256 = sha256Buffer(read.bytes)
  const decoded = decodeUtf8(read.bytes, displayPath)
  if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256) {
    throw new HashMismatchError(displayPath, options.expectedSha256, sha256)
  }

  const totalLines = decoded.text.split(/\r?\n/).length

  return {
    displayPath,
    text: decoded.text,
    bytes: read.bytes.length,
    totalLines,
    encoding: decoded.encoding,
    sha256,
    stableDuringRead: read.stableDuringRead,
    metadataBefore: read.metadataBefore,
    metadataAfter: read.metadataAfter,
  }
}

function remainingLineBudget(operation: Operation): number {
  return Math.max(0, operation.limits.maxTotalLines - operation.usage.lines)
}

function consumeLineBudget(lines: string[], operation: Operation, coverage: Coverage): string[] {
  const remaining = remainingLineBudget(operation)
  if (remaining <= 0) {
    markTruncation(coverage, "lineLimitReached", "maxTotalLines")
    return []
  }
  const selected = lines.slice(0, remaining)
  operation.usage.lines += selected.length
  if (selected.length < lines.length) markTruncation(coverage, "lineLimitReached", "maxTotalLines")
  return selected
}

function boundedLineText(line: string): { text: string; textTruncated: boolean } {
  if (line.length <= DEFAULT_MAX_MATCH_TEXT_CHARS) return { text: line, textTruncated: false }
  return { text: `${line.slice(0, DEFAULT_MAX_MATCH_TEXT_CHARS)}...`, textTruncated: true }
}

function matchText(line: string, query: string, caseSensitive: boolean): { text: string; truncated: boolean } {
  if (line.length <= DEFAULT_MAX_MATCH_TEXT_CHARS) return { text: line, truncated: false }

  const haystack = caseSensitive ? line : line.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const matchIndex = haystack.indexOf(needle)
  const halfWindow = Math.floor(Math.max(0, DEFAULT_MAX_MATCH_TEXT_CHARS - needle.length) / 2)
  let start = matchIndex >= 0 ? Math.max(0, matchIndex - halfWindow) : 0
  if (start + DEFAULT_MAX_MATCH_TEXT_CHARS > line.length) {
    start = Math.max(0, line.length - DEFAULT_MAX_MATCH_TEXT_CHARS)
  }
  const end = Math.min(line.length, start + DEFAULT_MAX_MATCH_TEXT_CHARS)
  return {
    text: `${start > 0 ? "..." : ""}${line.slice(start, end)}${end < line.length ? "..." : ""}`,
    truncated: true,
  }
}

function roleForPath(displayPath: string): FileRole {
  const lower = displayPath.toLowerCase()
  const basename = basenameOf(lower)
  const extension = path.posix.extname(basename)
  const segments = lower.split("/")

  if (lower.startsWith(".github/workflows/") || CI_FILENAMES.has(basename)) return "ci"
  if (MANIFEST_FILENAMES.has(basename)) return "manifest"
  if (segments.some((segment) => TEST_SEGMENTS.has(segment)) || /(?:^|[._-])(test|spec)(?:[._-]|$)/.test(basename) || /test\.[a-z0-9]+$/.test(basename)) {
    return "test"
  }
  if (DOC_EXTENSIONS.has(extension) || lower.startsWith("docs/")) return "doc"
  if (CONFIG_FILENAMES.has(basename) || CONFIG_EXTENSIONS.has(extension)) return "config"
  if (languageForPath(displayPath) !== "unknown") return "source"
  return "other"
}

function toFileEntry(entry: { path: string; size: number }): FileEntry {
  return {
    path: entry.path,
    size: entry.size,
    language: languageForPath(entry.path),
    role: roleForPath(entry.path),
  }
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const counts = {} as Record<T, number>
  for (const value of values) counts[value] = (counts[value] || 0) + 1
  return counts
}

function directorySummary(files: FileEntry[], depth: number): Array<{ path: string; files: number; roles: Record<string, number> }> {
  const directories = new Map<string, { files: number; roles: Record<string, number> }>()
  for (const file of files) {
    const segments = file.path.split("/")
    if (segments.length <= 1) continue
    const dirPath = segments.slice(0, Math.min(depth, segments.length - 1)).join("/")
    const current = directories.get(dirPath) || { files: 0, roles: {} }
    current.files++
    current.roles[file.role] = (current.roles[file.role] || 0) + 1
    directories.set(dirPath, current)
  }

  return [...directories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pathName, summary]) => ({ path: pathName, ...summary }))
}

async function findGuidance(root: string, policy: Policy, operation: Operation): Promise<string[]> {
  const guidanceCandidates = [
    "AGENTS.md",
    "WORKFLOW.md",
    ".opencode/skills/project/SKILL.md",
    ".opencode/skills/tests/SKILL.md",
    ".opencode/skills/release/SKILL.md",
    ".agents/skills",
  ]
  const guidance: string[] = []
  for (const candidate of guidanceCandidates) {
    checkOperation(operation)
    if (classifyPath(candidate, policy)) continue
    const target = resolveInside(root, candidate)
    const stat = await safeLstat(target, operation)
    if (!stat || stat.isSymbolicLink()) continue
    const realTarget = await safeRealPath(target)
    if (realTarget && isInside(root, realTarget)) guidance.push(candidate)
  }
  return guidance.sort()
}

function addSymbol(symbols: SymbolEntry[], file: FileEntry, sourceSha256: string | undefined, line: number, kind: SymbolEntry["kind"], name: string, signature?: string): void {
  symbols.push({
    path: file.path,
    line,
    language: file.language,
    kind,
    name,
    signature: signature ? boundedLineText(signature.trim()).text : undefined,
    confidence: "medium",
    extractor: `regex-${file.language}-v1`,
    sourceSha256,
  })
}

function extractSymbols(file: FileEntry, text: string, sourceSha256?: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue

    if (file.language === "typescript" || file.language === "javascript") {
      const tsMatches: Array<[RegExp, SymbolEntry["kind"]]> = [
        [/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, "function"],
        [/(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class"],
        [/(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, "interface"],
        [/(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/, "type"],
        [/(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/, "enum"],
        [/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[=:]/, "constant"],
      ]
      for (const [pattern, kind] of tsMatches) {
        const match = trimmed.match(pattern)
        if (match) addSymbol(symbols, file, sourceSha256, i + 1, kind, match[1], trimmed)
      }
      continue
    }

    if (file.language === "python") {
      const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)\b/)
      if (classMatch) addSymbol(symbols, file, sourceSha256, i + 1, "class", classMatch[1], trimmed)
      const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
      if (functionMatch) addSymbol(symbols, file, sourceSha256, i + 1, "function", functionMatch[1], trimmed)
      continue
    }

    if (file.language === "java") {
      const typeMatch = trimmed.match(/(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/)
      if (typeMatch) {
        const kind = typeMatch[1] === "record" ? "record" : (typeMatch[1] as SymbolEntry["kind"])
        addSymbol(symbols, file, sourceSha256, i + 1, kind, typeMatch[2], trimmed)
        continue
      }
      const methodMatch = trimmed.match(/(?:public|protected|private|static|final|synchronized|abstract|\s)+[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/)
      if (methodMatch && !["catch", "for", "if", "new", "switch", "while"].includes(methodMatch[1])) {
        addSymbol(symbols, file, sourceSha256, i + 1, "method", methodMatch[1], trimmed)
      }
    }
  }

  return symbols.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name))
}

async function collectSymbols(
  root: string,
  files: FileEntry[],
  policy: Policy,
  operation: Operation,
  coverage: Coverage,
  predicate?: (symbol: SymbolEntry) => boolean,
): Promise<{ symbols: SymbolEntry[]; contentEntries: Array<{ path: string; sha256: string }> }> {
  const symbols: SymbolEntry[] = []
  const contentEntries: Array<{ path: string; sha256: string }> = []
  let symbolLimitReached = false

  for (const file of files) {
    checkOperation(operation)
    if (symbolLimitReached) break
    if (!SYMBOL_LANGUAGES.has(file.language)) {
      coverage.unsupportedLanguages[file.language] = (coverage.unsupportedLanguages[file.language] || 0) + 1
      continue
    }
    if (remainingLineBudget(operation) <= 0) {
      markTruncation(coverage, "lineLimitReached", "maxTotalLines")
      break
    }
    try {
      const textFile = await readTextFile(root, file.path, policy, operation)
      coverage.scannedFiles++
      coverage.bytesScanned += textFile.bytes
      contentEntries.push({ path: file.path, sha256: textFile.sha256 })
      const allLines = textFile.text.split(/\r?\n/)
      const scanLines = consumeLineBudget(allLines, operation, coverage)
      if (scanLines.length === 0 && allLines.length > 0) break
      const extracted = extractSymbols(file, scanLines.join("\n"), textFile.sha256)
      for (const symbol of extracted) {
        if (predicate && !predicate(symbol)) continue
        if (symbols.length >= operation.limits.maxSymbols) {
          markTruncation(coverage, "symbolLimitReached", "maxSymbols")
          symbolLimitReached = true
          break
        }
        symbols.push(symbol)
      }
      if (scanLines.length < allLines.length) break
    } catch (error) {
      if (isAbortError(error) || error instanceof DeadlineExceededError) throw error
      markReadFailure(coverage, error)
    }
  }

  return {
    symbols: symbols.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)),
    contentEntries,
  }
}

type ImportIndexEntry = { imports: string[]; sha256: string; language: string }

function extractRelativeImports(text: string): string[] {
  const imports = new Set<string>()
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
    /\bexport\s+[^'"]+\s+from\s+["'](\.{1,2}\/[^"']+)["']/g,
    /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) imports.add(match[1])
  }
  return [...imports].sort()
}

function resolveImportPath(fromPath: string, specifier: string, fileSet: Set<string>): string | null {
  const baseDirectory = dirnameOf(fromPath) === WORKTREE_DISPLAY ? "" : dirnameOf(fromPath)
  const normalized = path.posix.normalize(path.posix.join(baseDirectory, specifier))
  if (normalized.startsWith("../") || normalized === "..") return null

  const candidates = [normalized]
  for (const extension of RELATED_EXTENSIONS) candidates.push(`${normalized}${extension}`)
  for (const extension of RELATED_EXTENSIONS) candidates.push(path.posix.join(normalized, `index${extension}`))

  return candidates.find((candidate) => fileSet.has(candidate)) || null
}

function testStem(stem: string): string {
  return stem.replace(/(\.test|\.spec|test|spec)$/i, "")
}

function isLikelyTestFor(target: FileEntry, candidate: FileEntry): boolean {
  if (candidate.path === target.path || candidate.role !== "test") return false
  const targetStem = stemOf(target.path).toLowerCase()
  const candidateStem = testStem(stemOf(candidate.path).toLowerCase())
  if (candidateStem === targetStem) return true
  const targetBasename = basenameOf(target.path).toLowerCase()
  const candidateBasename = basenameOf(candidate.path).toLowerCase()
  return candidateBasename.includes(`${targetStem}.test`) || candidateBasename.includes(`${targetStem}.spec`) || candidateBasename === `${targetStem}test${path.posix.extname(targetBasename)}`
}

function pushRelated(target: RelatedEntry[], entry: RelatedEntry, seen: Set<string>, operation: Operation, coverage: Coverage): boolean {
  const key = `${entry.relationship}:${entry.path}:${entry.evidence}`
  if (seen.has(key)) return false
  if (operation.usage.matches >= operation.limits.maxRelationships) {
    markTruncation(coverage, "relationshipLimitReached", "maxRelationships")
    return false
  }
  seen.add(key)
  target.push(entry)
  operation.usage.matches++
  return true
}

async function collectRelated(
  root: string,
  targetFile: FileEntry,
  files: FileEntry[],
  policy: Policy,
  operation: Operation,
  coverage: Coverage,
  filters: {
    relationshipKinds?: Set<RelatedEntry["relationship"]>
    pathScope?: string
    extensions?: Set<string>
    includeLowConfidence: boolean
  },
  seedImport?: { path: string; entry: ImportIndexEntry },
): Promise<{ related: RelatedEntry[]; grouped: Record<RelatedEntry["relationship"], RelatedEntry[]>; contentEntries: Array<{ path: string; sha256: string }> }> {
  const fileSet = new Set(files.map((file) => file.path))
  const seen = new Set<string>()
  const related: RelatedEntry[] = []
  const grouped: Record<RelatedEntry["relationship"], RelatedEntry[]> = {
    "direct-import": [],
    "imported-by": [],
    "likely-test": [],
    "same-basename": [],
    sibling: [],
  }
  const importIndex = new Map<string, ImportIndexEntry>()
  if (seedImport) importIndex.set(seedImport.path, seedImport.entry)
  const contentEntries: Array<{ path: string; sha256: string }> = []

  const allow = (entry: RelatedEntry): boolean => {
    if (filters.relationshipKinds && !filters.relationshipKinds.has(entry.relationship)) return false
    if (!filters.includeLowConfidence && entry.confidence === "low") return false
    if (filters.pathScope && !entry.path.startsWith(filters.pathScope)) return false
    if (filters.extensions && filters.extensions.size > 0 && !filters.extensions.has(path.posix.extname(entry.path).toLowerCase())) return false
    return true
  }
  const add = (entry: RelatedEntry) => {
    if (!allow(entry)) return
    if (pushRelated(related, entry, seen, operation, coverage)) grouped[entry.relationship].push(entry)
  }

  for (const file of files) {
    checkOperation(operation)
    if (seedImport?.path === file.path) continue
    if (!IMPORT_LANGUAGES.has(file.language)) continue
    if (remainingLineBudget(operation) <= 0) {
      markTruncation(coverage, "lineLimitReached", "maxTotalLines")
      break
    }
    try {
      const textFile = await readTextFile(root, file.path, policy, operation)
      coverage.scannedFiles++
      coverage.bytesScanned += textFile.bytes
      contentEntries.push({ path: file.path, sha256: textFile.sha256 })
      const allLines = textFile.text.split(/\r?\n/)
      const scanLines = consumeLineBudget(allLines, operation, coverage)
      if (scanLines.length === 0 && allLines.length > 0) break
      importIndex.set(file.path, { imports: extractRelativeImports(scanLines.join("\n")), sha256: textFile.sha256, language: file.language })
      if (scanLines.length < allLines.length) break
    } catch (error) {
      if (isAbortError(error) || error instanceof DeadlineExceededError) throw error
      markReadFailure(coverage, error)
    }
  }

  const targetImports = importIndex.get(targetFile.path)
  if (targetImports) {
    for (const specifier of targetImports.imports) {
      const resolved = resolveImportPath(targetFile.path, specifier, fileSet)
      if (resolved) {
        add({
          path: resolved,
          relationship: "direct-import",
          evidence: specifier,
          confidence: "high",
          language: languageForPath(resolved),
          sourceSha256: targetImports.sha256,
        })
      }
    }
  }

  for (const file of files) {
    checkOperation(operation)
    if (file.path === targetFile.path) continue

    if (file.role === "test" && isLikelyTestFor(targetFile, file)) {
      add({ path: file.path, relationship: "likely-test", evidence: "test naming convention", confidence: "medium", language: file.language })
    }
    if (stemOf(file.path).toLowerCase() === stemOf(targetFile.path).toLowerCase()) {
      add({ path: file.path, relationship: "same-basename", evidence: `same basename as ${basenameOf(targetFile.path)}`, confidence: "low", language: file.language })
    }
    if (dirnameOf(file.path) === dirnameOf(targetFile.path)) {
      add({ path: file.path, relationship: "sibling", evidence: `same directory ${dirnameOf(targetFile.path)}`, confidence: "low", language: file.language })
    }

    const indexed = importIndex.get(file.path)
    if (indexed) {
      for (const specifier of indexed.imports) {
        const resolved = resolveImportPath(file.path, specifier, fileSet)
        if (resolved === targetFile.path) {
          add({
            path: file.path,
            relationship: "imported-by",
            evidence: specifier,
            confidence: "high",
            language: file.language,
            sourceSha256: indexed.sha256,
          })
        }
      }
    }
  }

  const order = { high: 0, medium: 1, low: 2 }
  related.sort((left, right) => order[left.confidence] - order[right.confidence] || left.path.localeCompare(right.path) || left.relationship.localeCompare(right.relationship))
  for (const key of Object.keys(grouped) as Array<RelatedEntry["relationship"]>) {
    grouped[key].sort((left, right) => order[left.confidence] - order[right.confidence] || left.path.localeCompare(right.path) || left.relationship.localeCompare(right.relationship))
  }
  return { related, grouped, contentEntries }
}

async function verifySnapshotIfRequested(
  root: string,
  startPath: string,
  policy: Policy,
  operation: Operation,
  scope: string,
  initialSnapshot: Snapshot,
  coverage: Coverage,
  options: { verifySnapshot?: boolean; requireStableSnapshot?: boolean },
  verificationFingerprint?: string,
  walkOptions: WalkOptions = { maxFiles: operation.limits.maxFiles },
): Promise<{ snapshot: Snapshot; staleFailure: boolean }> {
  if (!options.verifySnapshot && !options.requireStableSnapshot) return { snapshot: initialSnapshot, staleFailure: false }
  checkOperation(operation)
  const verificationOperation: Operation = {
    signal: operation.signal,
    startedAt: performance.now(),
    deadlineAt: operation.deadlineAt,
    limits: operation.limits,
    usage: { files: 0, directories: 0, bytes: 0, lines: 0, matches: 0, ranges: 0 },
  }
  const secondPass = await walkFiles(root, startPath, policy, verificationOperation, walkOptions)
  const afterFingerprint = metadataFingerprint(secondPass.metadata)
  const beforeFingerprint = verificationFingerprint ?? initialSnapshot.fingerprint
  const changed = beforeFingerprint !== afterFingerprint
  const snapshot: Snapshot = {
    ...initialSnapshot,
    fingerprintScope: scope,
    stable: !changed,
    changedDuringOperation: changed,
    beforeFingerprint,
    afterFingerprint,
  }
  if (changed) {
    markTruncation(coverage, "snapshotChanged", "snapshotChanged")
    snapshot.truncationReasons = [...coverage.truncationReasons]
  }
  return { snapshot, staleFailure: changed && !!options.requireStableSnapshot }
}

function fileRange(file: ReadFileResult, startLine: number, maxLines: number): {
  selected: string[]
  startLine: number
  endLine: number
  truncatedBefore: boolean
  truncatedAfter: boolean
  rangeFingerprint: string
} {
  const lines = file.text.split(/\r?\n/)
  const safeStartLine = clampInt(startLine, 1, 1, Math.max(1, lines.length))
  const safeMaxLines = clampInt(maxLines, 160, 1, 500)
  const startIndex = safeStartLine - 1
  const selected = lines.slice(startIndex, startIndex + safeMaxLines)
  const endLine = safeStartLine + selected.length - 1
  return {
    selected,
    startLine: safeStartLine,
    endLine,
    truncatedBefore: safeStartLine > 1,
    truncatedAfter: endLine < lines.length,
    rangeFingerprint: `${safeStartLine}-${endLine}`,
  }
}

function commonScope(pathValue: string | undefined, filters: Record<string, unknown> = {}): Record<string, unknown> {
  return { path: pathValue || WORKTREE_DISPLAY, filters }
}

function textReadHashMismatch(error: HashMismatchError): string {
  return [`path: ${error.displayPath}`, "status: hash-mismatch", `expectedSha256: ${error.expectedSha256}`, `actualSha256: ${error.actualSha256}`].join("\n")
}

function buildTools(config: PluginConfig): Record<ToolId, ReturnType<typeof tool>> {
  const enabledToolNames = config.enabledToolIds

  return {
    context_outline: tool({
      description:
        "Read-only worktree outline for large audits. Returns schema metadata, enabled tool names, local guidance hints, and a bounded file sample.",
      args: {
        verifySnapshot: tool.schema.boolean().optional().describe("Run a second metadata pass and report if the scope changed during the call."),
        requireStableSnapshot: tool.schema.boolean().optional().describe("Fail with stale-snapshot if the second metadata pass differs."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional().describe("Caller deadline, capped by host configuration."),
      },
      async execute(args, context) {
        const op = operation(context, config, { maxFiles: 200, maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs) })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(WORKTREE_DISPLAY)
        const coverage = emptyCoverage()
        try {
          const top = await walkFiles(root, root, config.policy, op, { maxFiles: op.limits.maxFiles })
          mergeCoverage(coverage, top.coverage)
          const guidance = await findGuidance(root, config.policy, op)
          const initialSnapshot = snapshotFromMetadata(WORKTREE_DISPLAY, top.metadata, coverage)
          const verified = await verifySnapshotIfRequested(root, root, config.policy, op, WORKTREE_DISPLAY, initialSnapshot, coverage, args)
          if (verified.staleFailure) {
            return jsonEnvelope("context_outline", scope, verified.snapshot, coverage, op, { ok: false, error: "stale-snapshot" })
          }
          return jsonEnvelope("context_outline", scope, verified.snapshot, coverage, op, {
            guidance,
            filesSample: top.files.slice(0, 80).map(({ path: filePath, size }) => ({ path: filePath, size })),
            tools: enabledToolNames,
            toolset: config.toolset,
            explicitEnabledTools: config.explicitEnabledTools,
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_outline", scope, coverage, op)
          throw error
        }
      },
    }),

    context_map: tool({
      description:
        "Read-only project map with guidance, manifests, CI files, languages, roles, directories, and heuristic symbol coverage.",
      args: {
        path: tool.schema.string().optional().describe("Relative path to map from. Defaults to worktree root."),
        depth: tool.schema.number().int().min(1).max(5).optional().describe("Directory summary depth."),
        limit: tool.schema.number().int().min(1).max(HARD_LIMITS.maxFiles).optional().describe("Maximum files to inspect, capped by host configuration."),
        includeSymbols: tool.schema.boolean().optional().describe("Whether to include a compact symbol sample. Defaults to true."),
        verifySnapshot: tool.schema.boolean().optional().describe("Run a second metadata pass and report if the scope changed during the call."),
        requireStableSnapshot: tool.schema.boolean().optional().describe("Fail with stale-snapshot if the second metadata pass differs."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
      },
      async execute(args, context) {
        const maxFiles = limitValue(args.limit, 800, 1, config.ceilings.maxFiles)
        const op = operation(context, config, { maxFiles, maxSymbols: 80, maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs) })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(args.path)
        const coverage = emptyCoverage()
        try {
          const startPath = await resolveExistingInside(root, args.path, config.policy, op)
          if (!startPath) {
            const snapshot = snapshotFromMetadata(String(scope.path), [], coverage)
            return jsonEnvelope("context_map", scope, snapshot, coverage, op, {
              files: [],
              directories: [],
              guidance: [],
              languages: {},
              roles: {},
              manifests: [],
              ci: [],
              docs: [],
              tests: [],
              symbols: [],
            })
          }

          const inventory = await walkFiles(root, startPath, config.policy, op, { maxFiles })
          mergeCoverage(coverage, inventory.coverage)
          const files = inventory.files.map(toFileEntry)
          const includeSymbols = args.includeSymbols ?? true
          const symbolSample = includeSymbols ? await collectSymbols(root, files, config.policy, op, coverage) : { symbols: [], contentEntries: [] }
          const initialSnapshot = snapshotFromMetadata(toDisplayPath(root, startPath), inventory.metadata, coverage)
          const verified = await verifySnapshotIfRequested(root, startPath, config.policy, op, toDisplayPath(root, startPath), initialSnapshot, coverage, args)
          if (verified.staleFailure) return jsonEnvelope("context_map", scope, verified.snapshot, coverage, op, { ok: false, error: "stale-snapshot" })
          return jsonEnvelope("context_map", scope, verified.snapshot, coverage, op, {
            path: toDisplayPath(root, startPath),
            guidance: await findGuidance(root, config.policy, op),
            files: files.slice(0, 120),
            directories: directorySummary(files, clampInt(args.depth, 2, 1, 5)).slice(0, 120),
            languages: countBy(files.map((file) => file.language)),
            roles: countBy(files.map((file) => file.role)),
            manifests: files.filter((file) => file.role === "manifest").slice(0, 40),
            ci: files.filter((file) => file.role === "ci").slice(0, 40),
            docs: files.filter((file) => file.role === "doc").slice(0, 40),
            tests: files.filter((file) => file.role === "test").slice(0, 40),
            symbols: symbolSample.symbols,
            symbolsCoverage: {
              extractor: "regex-v1",
              supportedLanguages: [...SYMBOL_LANGUAGES].sort(),
              unsupportedLanguageFileCounts: coverage.unsupportedLanguages,
              contentFingerprint: contentFingerprint(symbolSample.contentEntries),
            },
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_map", scope, coverage, op)
          throw error
        }
      },
    }),

    context_files: tool({
      description:
        "Read-only file inventory inside the current worktree. Use for broad audits before choosing focused searches or subagents.",
      args: {
        path: tool.schema.string().optional().describe("Relative path to list from. Defaults to worktree root."),
        contains: tool.schema.string().optional().describe("Optional case-insensitive substring filter on file paths."),
        limit: tool.schema.number().int().min(1).max(HARD_LIMITS.maxFiles).optional().describe("Maximum files to return, capped by host configuration."),
        verifySnapshot: tool.schema.boolean().optional().describe("Run a second metadata pass and report if the scope changed during the call."),
        requireStableSnapshot: tool.schema.boolean().optional().describe("Fail with stale-snapshot if the second metadata pass differs."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
      },
      async execute(args, context) {
        const maxFiles = limitValue(args.limit, DEFAULT_LIMITS.maxFiles, 1, config.ceilings.maxFiles)
        const op = operation(context, config, { maxFiles, maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs) })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(args.path, { contains: args.contains })
        const coverage = emptyCoverage()
        try {
          const startPath = await resolveExistingInside(root, args.path, config.policy, op)
          if (!startPath) {
            const snapshot = snapshotFromMetadata(String(scope.path), [], coverage)
            return jsonEnvelope("context_files", scope, snapshot, coverage, op, { files: [] })
          }
          const inventoryOptions = { maxFiles, contains: args.contains }
          const result = await walkFiles(root, startPath, config.policy, op, inventoryOptions)
          mergeCoverage(coverage, result.coverage)
          const initialSnapshot = snapshotFromMetadata(toDisplayPath(root, startPath), result.metadata, coverage)
          const verified = await verifySnapshotIfRequested(root, startPath, config.policy, op, toDisplayPath(root, startPath), initialSnapshot, coverage, args, undefined, inventoryOptions)
          if (verified.staleFailure) return jsonEnvelope("context_files", scope, verified.snapshot, coverage, op, { ok: false, error: "stale-snapshot" })
          return jsonEnvelope("context_files", scope, verified.snapshot, coverage, op, {
            files: result.files.map(({ path: filePath, size }) => ({ path: filePath, size })),
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_files", scope, coverage, op)
          throw error
        }
      },
    }),

    context_batch_read: tool({
      description:
        "Read-only batch line-range reader for multiple non-secret text files inside the current worktree. JSON output includes hashes and per-file consistency metadata.",
      args: {
        ranges: tool.schema
          .array(
            tool.schema.object({
              path: tool.schema.string().describe("Relative file path to read."),
              startLine: tool.schema.number().int().min(1).optional().describe("1-based start line. Defaults to 1."),
              maxLines: tool.schema.number().int().min(1).max(500).optional().describe("Maximum lines for this file."),
              expectedSha256: tool.schema.string().optional().describe("Expected full-file SHA-256. A mismatch returns hash-mismatch without content."),
            }),
          )
          .min(1)
          .max(HARD_LIMITS.maxBatchRanges)
          .describe("Line ranges to read."),
        maxTotalLines: tool.schema.number().int().min(1).max(HARD_LIMITS.maxTotalLines).optional().describe("Total line cap across all ranges."),
        maxBytesPerFile: tool.schema.number().int().min(1024).max(HARD_LIMITS.maxBytesPerFile).optional().describe("Safety cap per file."),
        maxTotalBytes: tool.schema.number().int().min(1024).max(HARD_LIMITS.maxTotalBytes).optional().describe("Total bytes cap for this batch."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
      },
      async execute(args, context) {
        const op = operation(context, config, {
          maxBatchRanges: limitValue(args.ranges.length, DEFAULT_LIMITS.maxBatchRanges, 1, config.ceilings.maxBatchRanges),
          maxTotalLines: limitValue(args.maxTotalLines, DEFAULT_BATCH_TOTAL_LINES, 1, config.ceilings.maxTotalLines),
          maxBytesPerFile: limitValue(args.maxBytesPerFile, DEFAULT_LIMITS.maxBytesPerFile, 1024, config.ceilings.maxBytesPerFile),
          maxTotalBytes: limitValue(args.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, 1024, config.ceilings.maxTotalBytes),
          maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs),
        })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(WORKTREE_DISPLAY, { ranges: args.ranges.map((range) => range.path) })
        const coverage = emptyCoverage()
        const contentEntries: Array<{ path: string; sha256: string; range?: string }> = []
        const results: Array<Record<string, unknown>> = []
        let usedLines = 0

        try {
          if (args.ranges.length > op.limits.maxBatchRanges) {
            markTruncation(coverage, "resultLimitReached", "maxBatchRanges")
          }
          for (const range of args.ranges.slice(0, op.limits.maxBatchRanges)) {
            checkOperation(op)
            op.usage.ranges++
            if (usedLines >= op.limits.maxTotalLines) {
              markTruncation(coverage, "lineLimitReached", "maxTotalLines")
              results.push({ path: safeRequestedPath(range.path), ok: false, error: "line-limit-reached" })
              continue
            }
            try {
              const file = await readTextFile(root, range.path, config.policy, op, { expectedSha256: range.expectedSha256 })
              coverage.scannedFiles++
              coverage.bytesScanned += file.bytes
              const requestedLines = clampInt(range.maxLines, 160, 1, 500)
              const availableLines = Math.max(0, op.limits.maxTotalLines - usedLines)
              const selectedMaxLines = Math.min(requestedLines, availableLines)
              if (selectedMaxLines < requestedLines) markTruncation(coverage, "lineLimitReached", "maxTotalLines")
              const selected = fileRange(file, range.startLine || 1, selectedMaxLines)
              usedLines += selected.selected.length
              op.usage.lines += selected.selected.length
              contentEntries.push({ path: file.displayPath, sha256: file.sha256, range: selected.rangeFingerprint })
              results.push({
                path: file.displayPath,
                ok: true,
                sha256: file.sha256,
                bytes: file.bytes,
                totalLines: file.totalLines,
                selectedRange: { startLine: selected.startLine, endLine: selected.endLine },
                encoding: file.encoding,
                stableDuringRead: file.stableDuringRead,
                metadataBefore: file.metadataBefore,
                metadataAfter: file.metadataAfter,
                truncatedBefore: selected.truncatedBefore,
                truncatedAfter: selected.truncatedAfter,
                text: selected.selected.map((line, index) => `${selected.startLine + index}: ${line}`).join("\n"),
              })
            } catch (error) {
              if (isAbortError(error) || error instanceof DeadlineExceededError) throw error
              if (error instanceof HashMismatchError) {
                results.push({
                  path: error.displayPath,
                  ok: false,
                  error: "hash-mismatch",
                  expectedSha256: error.expectedSha256,
                  actualSha256: error.actualSha256,
                })
              } else if (error instanceof ByteLimitExceededError) {
                markReadFailure(coverage, error)
                results.push({ path: safeRequestedPath(range.path), ok: false, error: "byte-limit-reached", limit: error.limit })
              } else {
                markReadFailure(coverage, error)
                results.push({ path: safeRequestedPath(range.path), ok: false, error: error instanceof Error ? error.message : "Read failed" })
              }
            }
          }
          const snapshot = snapshotFromContent(WORKTREE_DISPLAY, contentEntries, coverage)
          return jsonEnvelope("context_batch_read", scope, snapshot, coverage, op, {
            results,
            usedLines,
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_batch_read", scope, coverage, op)
          throw error
        }
      },
    }),

    context_read: tool({
      description:
        "Read-only line-range reader for a non-secret UTF-8 text file inside the current worktree. Default text output is backward compatible; format=json returns schema metadata and hashes.",
      args: {
        path: tool.schema.string().describe("Relative file path to read."),
        startLine: tool.schema.number().int().min(1).optional().describe("1-based start line. Defaults to 1."),
        maxLines: tool.schema.number().int().min(1).max(500).optional().describe("Maximum lines to return."),
        maxBytes: tool.schema.number().int().min(1024).max(HARD_LIMITS.maxBytesPerFile).optional().describe("Safety cap for file size."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
        expectedSha256: tool.schema.string().optional().describe("Expected full-file SHA-256. A mismatch returns hash-mismatch without content."),
        format: tool.schema.enum(["text", "json"]).optional().describe("Output format. Defaults to text for compatibility."),
      },
      async execute(args, context) {
        const op = operation(context, config, {
          maxBytesPerFile: limitValue(args.maxBytes, DEFAULT_LIMITS.maxBytesPerFile, 1024, config.ceilings.maxBytesPerFile),
          maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs),
        })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(args.path)
        const coverage = emptyCoverage()
        try {
          const file = await readTextFile(root, args.path, config.policy, op, { expectedSha256: args.expectedSha256 })
          coverage.scannedFiles = 1
          coverage.bytesScanned = file.bytes
          const requestedLines = clampInt(args.maxLines, 160, 1, 500)
          const selectedMaxLines = Math.min(requestedLines, remainingLineBudget(op))
          if (selectedMaxLines < requestedLines) markTruncation(coverage, "lineLimitReached", "maxTotalLines")
          const selected = fileRange(file, args.startLine || 1, selectedMaxLines)
          op.usage.lines += selected.selected.length
          const snapshot = snapshotFromContent(file.displayPath, [{ path: file.displayPath, sha256: file.sha256, range: selected.rangeFingerprint }], coverage)
          if (args.format === "json") {
            return jsonEnvelope("context_read", scope, snapshot, coverage, op, {
              ok: true,
              path: file.displayPath,
              sha256: file.sha256,
              bytes: file.bytes,
              totalLines: file.totalLines,
              selectedRange: { startLine: selected.startLine, endLine: selected.endLine },
              encoding: file.encoding,
              stableDuringRead: file.stableDuringRead,
              metadataBefore: file.metadataBefore,
              metadataAfter: file.metadataAfter,
              truncatedBefore: selected.truncatedBefore,
              truncatedAfter: selected.truncatedAfter,
              text: selected.selected.map((line, index) => `${selected.startLine + index}: ${line}`).join("\n"),
            })
          }

          return [
            `path: ${file.displayPath}`,
            `bytes: ${file.bytes}`,
            `sha256: ${file.sha256}`,
            `encoding: ${file.encoding}`,
            `stableDuringRead: ${file.stableDuringRead}`,
            `lines: ${selected.startLine}-${selected.endLine} of ${file.totalLines}`,
            `truncatedBefore: ${selected.truncatedBefore}`,
            `truncatedAfter: ${selected.truncatedAfter}`,
            "",
            selected.selected.map((line, index) => `${selected.startLine + index}: ${line}`).join("\n"),
          ].join("\n")
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) {
            if (args.format === "json") return deadlineFailure("context_read", scope, coverage, op)
            return "status: deadline-exceeded"
          }
          if (error instanceof HashMismatchError) {
            if (args.format === "json") {
              const snapshot = snapshotFromContent(error.displayPath, [{ path: error.displayPath, sha256: error.actualSha256 }], coverage)
              return jsonEnvelope("context_read", scope, snapshot, coverage, op, {
                ok: false,
                error: "hash-mismatch",
                path: error.displayPath,
                expectedSha256: error.expectedSha256,
                actualSha256: error.actualSha256,
              })
            }
            return textReadHashMismatch(error)
          }
          throw error
        }
      },
    }),

    context_symbols: tool({
      description:
        "Read-only heuristic symbol discovery for TypeScript, JavaScript, Python, and Java files. Uses regex extractors, not AST parsing.",
      args: {
        path: tool.schema.string().optional().describe("Relative path to scan from. Defaults to worktree root."),
        query: tool.schema.string().optional().describe("Optional case-insensitive substring filter on symbol name or signature."),
        kind: tool.schema.string().optional().describe("Optional symbol kind filter."),
        limit: tool.schema.number().int().min(1).max(HARD_LIMITS.maxSymbols).optional().describe("Maximum symbols to return, capped by host configuration."),
        verifySnapshot: tool.schema.boolean().optional().describe("Run a second metadata pass and report if the scope changed during the call."),
        requireStableSnapshot: tool.schema.boolean().optional().describe("Fail with stale-snapshot if the second metadata pass differs."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
      },
      async execute(args, context) {
        const maxSymbols = limitValue(args.limit, DEFAULT_LIMITS.maxSymbols, 1, config.ceilings.maxSymbols)
        const op = operation(context, config, { maxSymbols, maxFiles: 3_000, maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs) })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(args.path, { query: args.query, kind: args.kind })
        const coverage = emptyCoverage()
        try {
          const startPath = await resolveExistingInside(root, args.path, config.policy, op)
          if (!startPath) {
            const snapshot = snapshotFromContent(String(scope.path), [], coverage)
            return jsonEnvelope("context_symbols", scope, snapshot, coverage, op, { symbols: [] })
          }
          const inventory = await walkFiles(root, startPath, config.policy, op, { maxFiles: op.limits.maxFiles })
          mergeCoverage(coverage, inventory.coverage)
          const inventoryFingerprint = metadataFingerprint(inventory.metadata)
          const files = inventory.files.map(toFileEntry)
          const query = args.query?.toLowerCase()
          const kind = args.kind?.toLowerCase()
          const collected = await collectSymbols(root, files, config.policy, op, coverage, (symbol) => {
            if (kind && symbol.kind !== kind) return false
            if (!query) return true
            return symbol.name.toLowerCase().includes(query) || (symbol.signature || "").toLowerCase().includes(query)
          })
          const initialSnapshot = snapshotFromContent(toDisplayPath(root, startPath), collected.contentEntries, coverage)
          const verified = await verifySnapshotIfRequested(root, startPath, config.policy, op, toDisplayPath(root, startPath), initialSnapshot, coverage, args, inventoryFingerprint)
          if (verified.staleFailure) return jsonEnvelope("context_symbols", scope, verified.snapshot, coverage, op, { ok: false, error: "stale-snapshot" })
          return jsonEnvelope("context_symbols", scope, verified.snapshot, coverage, op, {
            path: toDisplayPath(root, startPath),
            symbols: collected.symbols,
            semanticCoverage: {
              extractor: "regex-v1",
              supportedLanguages: [...SYMBOL_LANGUAGES].sort(),
              unsupportedLanguageFileCounts: coverage.unsupportedLanguages,
              note: "Regex extraction is heuristic orientation, not AST parsing.",
            },
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_symbols", scope, coverage, op)
          throw error
        }
      },
    }),

    context_related: tool({
      description:
        "Read-only heuristic related-file discovery for a target file. It is not a full dependency graph or call graph.",
      args: {
        path: tool.schema.string().describe("Relative target file path."),
        maxResults: tool.schema.number().int().min(1).max(HARD_LIMITS.maxRelationships).optional().describe("Maximum related entries across all groups."),
        relationshipKinds: tool.schema.array(tool.schema.enum(["direct-import", "imported-by", "likely-test", "same-basename", "sibling"])).max(5).optional(),
        scopePath: tool.schema.string().optional().describe("Optional relative path prefix for returned related entries."),
        extensions: tool.schema.array(tool.schema.string()).max(20).optional().describe("Optional extension filters for returned related entries."),
        includeLowConfidence: tool.schema.boolean().optional().describe("Include low-confidence same-basename and sibling relations. Defaults to true."),
        verifySnapshot: tool.schema.boolean().optional().describe("Run a second metadata pass and report if the scope changed during the call."),
        requireStableSnapshot: tool.schema.boolean().optional().describe("Fail with stale-snapshot if the second metadata pass differs."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
      },
      async execute(args, context) {
        const maxRelationships = limitValue(args.maxResults, DEFAULT_LIMITS.maxRelationships, 1, config.ceilings.maxRelationships)
        const op = operation(context, config, { maxRelationships, maxFiles: 5_000, maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs) })
        const root = await projectRoot(context, context.abort)
        const scope = commonScope(args.path, {
          relationshipKinds: args.relationshipKinds,
          scopePath: args.scopePath,
          extensions: args.extensions,
          includeLowConfidence: args.includeLowConfidence ?? true,
        })
        const coverage = emptyCoverage()
        try {
          const target = await readTextFile(root, args.path, config.policy, op)
          const targetFile = toFileEntry({ path: target.displayPath, size: target.bytes })
          let targetImportSeed: { path: string; entry: ImportIndexEntry } | undefined
          if (IMPORT_LANGUAGES.has(targetFile.language)) {
            coverage.scannedFiles++
            coverage.bytesScanned += target.bytes
            const targetLines = target.text.split(/\r?\n/)
            const scannedTargetLines = consumeLineBudget(targetLines, op, coverage)
            targetImportSeed = {
              path: targetFile.path,
              entry: {
                imports: extractRelativeImports(scannedTargetLines.join("\n")),
                sha256: target.sha256,
                language: targetFile.language,
              },
            }
          }
          const inventory = await walkFiles(root, root, config.policy, op, { maxFiles: op.limits.maxFiles })
          mergeCoverage(coverage, inventory.coverage)
          const inventoryFingerprint = metadataFingerprint(inventory.metadata)
          const files = inventory.files.map(toFileEntry)
          const filters = {
            relationshipKinds: args.relationshipKinds ? new Set(args.relationshipKinds) : undefined,
            pathScope: args.scopePath ? toPosixPath(args.scopePath).replace(/\/$/, "") : undefined,
            extensions: args.extensions ? new Set(args.extensions.map(normalizeExtension).filter(Boolean)) : undefined,
            includeLowConfidence: args.includeLowConfidence ?? true,
          }
          const collected = await collectRelated(root, targetFile, files, config.policy, op, coverage, filters, targetImportSeed)
          const contentEntries = [{ path: target.displayPath, sha256: target.sha256 }, ...collected.contentEntries]
          const initialSnapshot = snapshotFromContent(WORKTREE_DISPLAY, contentEntries, coverage)
          const verified = await verifySnapshotIfRequested(root, root, config.policy, op, WORKTREE_DISPLAY, initialSnapshot, coverage, args, inventoryFingerprint)
          if (verified.staleFailure) return jsonEnvelope("context_related", scope, verified.snapshot, coverage, op, { ok: false, error: "stale-snapshot" })
          return jsonEnvelope("context_related", scope, verified.snapshot, coverage, op, {
            target: target.displayPath,
            related: collected.related,
            directImports: collected.grouped["direct-import"],
            importedBy: collected.grouped["imported-by"],
            likelyTests: collected.grouped["likely-test"],
            sameBasename: collected.grouped["same-basename"],
            siblings: collected.grouped.sibling,
            semanticCoverage: {
              relationKinds: ["direct-import", "imported-by", "likely-test", "same-basename", "sibling"],
              supportedLanguages: [...IMPORT_LANGUAGES].sort(),
              scannedImportFiles: collected.contentEntries.length + (targetImportSeed ? 1 : 0),
              unsupportedMechanisms: RELATED_UNSUPPORTED_MECHANISMS,
              note: "Results are request-local heuristics, not a complete dependency graph or call graph.",
            },
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_related", scope, coverage, op)
          throw error
        }
      },
    }),

    context_search: tool({
      description:
        "Read-only literal text search inside the current worktree. Skips generated/dependency/cache dirs and secret-like files; reports coverage and per-file hashes.",
      args: {
        query: tool.schema.string().min(1).describe("Single-line literal text to search for."),
        path: tool.schema.string().optional().describe("Relative path to search from. Defaults to worktree root."),
        pathContains: tool.schema.string().optional().describe("Optional case-insensitive substring filter on file paths."),
        extensions: tool.schema.array(tool.schema.string()).max(20).optional().describe("Optional file extension filters."),
        contextLines: tool.schema.number().int().min(0).max(3).optional().describe("Context lines before and after each match."),
        caseSensitive: tool.schema.boolean().optional().describe("Defaults to false."),
        maxMatches: tool.schema.number().int().min(1).max(HARD_LIMITS.maxMatches).optional().describe("Maximum matching lines to return."),
        maxFiles: tool.schema.number().int().min(1).max(HARD_LIMITS.maxFiles).optional().describe("Maximum files to scan."),
        maxBytesPerFile: tool.schema.number().int().min(1024).max(HARD_LIMITS.maxBytesPerFile).optional().describe("Skip files above this size."),
        maxTotalBytes: tool.schema.number().int().min(1024).max(HARD_LIMITS.maxTotalBytes).optional().describe("Total bytes cap for the search."),
        maxTotalLines: tool.schema.number().int().min(1).max(HARD_LIMITS.maxTotalLines).optional().describe("Total text lines to scan, capped by host configuration."),
        verifySnapshot: tool.schema.boolean().optional().describe("Run a second metadata pass and report if the scope changed during the call."),
        requireStableSnapshot: tool.schema.boolean().optional().describe("Fail with stale-snapshot if the second metadata pass differs."),
        expectedSnapshotFingerprint: tool.schema.string().optional().describe("Optional metadata fingerprint expected by the caller."),
        maxDurationMs: tool.schema.number().int().min(1).max(HARD_LIMITS.maxDurationMs).optional(),
      },
      async execute(args, context) {
        if (args.query.includes("\n") || args.query.includes("\r")) {
          throw new Error("Multiline literal search queries are not supported; split the query into single-line searches.")
        }
        const defaultMaxFiles = args.expectedSnapshotFingerprint && args.maxFiles == null ? DEFAULT_LIMITS.maxFiles : 1_500
        const op = operation(context, config, {
          maxFiles: limitValue(args.maxFiles, defaultMaxFiles, 1, config.ceilings.maxFiles),
          maxMatches: limitValue(args.maxMatches, DEFAULT_LIMITS.maxMatches, 1, config.ceilings.maxMatches),
          maxBytesPerFile: limitValue(args.maxBytesPerFile, DEFAULT_LIMITS.maxBytesPerFile, 1024, config.ceilings.maxBytesPerFile),
          maxTotalBytes: limitValue(args.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes, 1024, config.ceilings.maxTotalBytes),
          maxTotalLines: limitValue(args.maxTotalLines, DEFAULT_LIMITS.maxTotalLines, 1, config.ceilings.maxTotalLines),
          maxDurationMs: limitValue(args.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 1, config.ceilings.maxDurationMs),
        })
        const root = await projectRoot(context, context.abort)
        const extensions = new Set((args.extensions || []).map(normalizeExtension).filter(Boolean))
        const scope = commonScope(args.path, {
          query: args.query,
          pathContains: args.pathContains,
          extensions: [...extensions].sort(),
          caseSensitive: args.caseSensitive ?? false,
        })
        const coverage = emptyCoverage()
        const contentEntries: Array<{ path: string; sha256: string }> = []
        try {
          const startPath = await resolveExistingInside(root, args.path, config.policy, op)
          if (!startPath) {
            const snapshot = snapshotFromContent(String(scope.path), [], coverage)
            return jsonEnvelope("context_search", scope, snapshot, coverage, op, { query: args.query, scanned: 0, matches: [], matchedFiles: [] })
          }
          const inventoryOptions: WalkOptions = {
            maxFiles: op.limits.maxFiles,
            contains: args.pathContains,
            includeFile: (displayPath: string) => extensions.size === 0 || extensions.has(path.posix.extname(displayPath).toLowerCase()),
          }
          const inventory = await walkFiles(root, startPath, config.policy, op, inventoryOptions)
          mergeCoverage(coverage, inventory.coverage)
          const inventorySnapshot = snapshotFromMetadata(toDisplayPath(root, startPath), inventory.metadata, coverage)
          if (args.expectedSnapshotFingerprint && args.expectedSnapshotFingerprint !== inventorySnapshot.fingerprint) {
            return jsonEnvelope("context_search", scope, inventorySnapshot, coverage, op, {
              ok: false,
              error: "snapshot-mismatch",
              expectedSnapshotFingerprint: args.expectedSnapshotFingerprint,
              actualSnapshotFingerprint: inventorySnapshot.fingerprint,
            })
          }

          const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
          const contextLines = clampInt(args.contextLines, 0, 0, 3)
          const matches: Array<{
            path: string
            line: number
            text: string
            textTruncated: boolean
            fileSha256: string
            contextBefore?: Array<{ line: number; text: string; textTruncated: boolean }>
            contextAfter?: Array<{ line: number; text: string; textTruncated: boolean }>
          }> = []
          const matchedFileMap = new Map<string, { path: string; sha256: string; bytes: number; matches: number }>()
          let matchLimitReached = false

          for (const entry of inventory.files) {
            checkOperation(op)
            if (matchLimitReached) break
            if (entry.size > op.limits.maxBytesPerFile) {
              coverage.skippedLarge++
              markTruncation(coverage, "byteLimitReached", "maxBytesPerFile")
              continue
            }
            if (op.usage.bytes + entry.size > op.limits.maxTotalBytes) {
              markTruncation(coverage, "byteLimitReached", "maxTotalBytes")
              break
            }
            if (remainingLineBudget(op) <= 0) {
              markTruncation(coverage, "lineLimitReached", "maxTotalLines")
              break
            }

            try {
              const file = await readTextFile(root, entry.path, config.policy, op)
              coverage.scannedFiles++
              coverage.bytesScanned += file.bytes
              contentEntries.push({ path: file.displayPath, sha256: file.sha256 })
              const allLines = file.text.split(/\r?\n/)
              const lines = consumeLineBudget(allLines, op, coverage)
              if (lines.length === 0 && allLines.length > 0) break
              for (let i = 0; i < lines.length; i++) {
                if (i % 250 === 0) checkOperation(op)
                const haystack = args.caseSensitive ? lines[i] : lines[i].toLowerCase()
                if (!haystack.includes(needle)) continue
                if (matches.length >= op.limits.maxMatches) {
                  markTruncation(coverage, "matchLimitReached", "maxMatches")
                  matchLimitReached = true
                  break
                }
                const text = matchText(lines[i], args.query, args.caseSensitive ?? false)
                if (text.truncated) markTruncation(coverage, "excerptTruncated", "excerptTruncated")
                const match = { path: file.displayPath, line: i + 1, text: text.text, textTruncated: text.truncated, fileSha256: file.sha256 }
                if (contextLines > 0) {
                  const before = lines.slice(Math.max(0, i - contextLines), i)
                  const after = lines.slice(i + 1, i + 1 + contextLines)
                  Object.assign(match, {
                    contextBefore: before.map((line, index) => {
                      const bounded = boundedLineText(line)
                      if (bounded.textTruncated) markTruncation(coverage, "contextBeforeTruncated", "contextBeforeTruncated")
                      return { line: i - before.length + index + 1, ...bounded }
                    }),
                    contextAfter: after.map((line, index) => {
                      const bounded = boundedLineText(line)
                      if (bounded.textTruncated) markTruncation(coverage, "contextAfterTruncated", "contextAfterTruncated")
                      return { line: i + index + 2, ...bounded }
                    }),
                  })
                }
                matches.push(match)
                op.usage.matches++
                const summary = matchedFileMap.get(file.displayPath) || { path: file.displayPath, sha256: file.sha256, bytes: file.bytes, matches: 0 }
                summary.matches++
                matchedFileMap.set(file.displayPath, summary)
              }
              if (matchLimitReached) break
              if (lines.length < allLines.length) break
            } catch (error) {
              if (isAbortError(error) || error instanceof DeadlineExceededError) throw error
              markReadFailure(coverage, error)
            }
          }

          const initialSnapshot = snapshotFromContent(toDisplayPath(root, startPath), contentEntries, coverage)
          const verified = await verifySnapshotIfRequested(root, startPath, config.policy, op, toDisplayPath(root, startPath), initialSnapshot, coverage, args, inventorySnapshot.fingerprint, inventoryOptions)
          if (verified.staleFailure) return jsonEnvelope("context_search", scope, verified.snapshot, coverage, op, { ok: false, error: "stale-snapshot" })
          return jsonEnvelope("context_search", scope, verified.snapshot, coverage, op, {
            query: args.query,
            scanned: coverage.scannedFiles,
            matches: matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
            matchedFiles: [...matchedFileMap.values()].sort((left, right) => left.path.localeCompare(right.path)),
            matchedFileCount: matchedFileMap.size,
            totalBytesScanned: coverage.bytesScanned,
          })
        } catch (error) {
          if (isAbortError(error)) throw error
          if (error instanceof DeadlineExceededError) return deadlineFailure("context_search", scope, coverage, op)
          throw error
        }
      },
    }),
  }
}

export const RecursiveContextPlugin: Plugin = async (_input, options) => {
  const config = parsePluginConfig(options)
  const tools = buildTools(config)
  const enabledEntries = config.enabledToolIds.map((id) => [id, tools[id]] as const)
  return {
    tool: Object.fromEntries(enabledEntries),
  }
}

export default RecursiveContextPlugin
