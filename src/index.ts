import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const IGNORE_DIRS = new Set([
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
])
const IGNORE_DIR_NAMES = new Set([...IGNORE_DIRS].map((name) => name.toLowerCase()))

const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube"])
const SECRET_FILENAMES = new Set([
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
])
const SECRET_EXTENSIONS = new Set([".key", ".keystore", ".jks", ".p8", ".p12", ".pem", ".pfx", ".kdbx"])
const SECRET_NAME_PATTERNS = [
  /^credentials\.(cfg|conf|ini|json|toml|txt|ya?ml)$/i,
  /^secrets?\.(cfg|conf|ini|json|toml|txt|ya?ml)$/i,
  /(^|[-_.])private[-_.]?key($|[-_.])/i,
  /(^|[-_.])service[-_.]?account($|[-_.])/i,
]

const DEFAULT_FILE_LIMIT = 500
const DEFAULT_MATCH_LIMIT = 100
const DEFAULT_MAX_READ_BYTES = 1_500_000
const DEFAULT_MAX_MATCH_TEXT_CHARS = 320
const DEFAULT_MAP_LIMIT = 800
const DEFAULT_SYMBOL_LIMIT = 200
const DEFAULT_RELATED_LIMIT = 80
const DEFAULT_BATCH_TOTAL_LINES = 1200

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

type WalkResult = {
  files: Array<{ path: string; size: number }>
  truncated: boolean
  skippedDirs: number
  skippedSecret: number
}

type FileEntry = {
  path: string
  size: number
  language: string
  role: "ci" | "config" | "doc" | "manifest" | "other" | "source" | "test"
}

type SymbolEntry = {
  path: string
  line: number
  language: string
  kind: "class" | "constant" | "enum" | "function" | "interface" | "method" | "record" | "type"
  name: string
  signature?: string
}

type RelatedEntry = {
  path: string
  reason: "direct-import" | "imported-by" | "likely-test" | "same-basename" | "sibling"
  detail?: string
}

async function projectRoot(context: { worktree?: string; directory: string }): Promise<string> {
  return await fs.realpath(path.resolve(context.worktree || context.directory))
}

function toDisplayPath(root: string, absolutePath: string): string {
  const rel = path.relative(root, absolutePath)
  return rel ? rel.split(path.sep).join("/") : "."
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/")
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel))
}

function resolveInside(root: string, requestedPath: string | undefined): string {
  const target = path.resolve(root, requestedPath || ".")
  if (!isInside(root, target)) {
    throw new Error(`Path is outside the worktree: ${requestedPath}`)
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

async function resolveExistingInside(root: string, requestedPath: string | undefined): Promise<string | null> {
  const target = resolveInside(root, requestedPath)
  const displayPath = toDisplayPath(root, target)
  if (hasSecretSegment(displayPath)) throw new Error(`Refusing secret-like path: ${displayPath}`)
  const realTarget = await safeRealPath(target)
  if (!realTarget) return null
  if (!isInside(root, realTarget)) {
    throw new Error(`Path resolves outside the worktree: ${requestedPath || "."}`)
  }
  return realTarget
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value as number)))
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
  return index >= 0 ? displayPath.slice(0, index) : "."
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

function isSecretName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SECRET_DIRS.has(lower)) return true
  if (SECRET_FILENAMES.has(lower)) return true
  if (lower.startsWith(".env.") && lower !== ".env.example") return true
  if (SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))) return true
  return SECRET_EXTENSIONS.has(path.extname(lower))
}

function shouldSkipDirectory(name: string): boolean {
  const lower = name.toLowerCase()
  return IGNORE_DIR_NAMES.has(lower) || SECRET_DIRS.has(lower)
}

function hasSecretSegment(displayPath: string): boolean {
  return displayPath.split("/").some(isSecretName)
}

function looksBinary(text: string): boolean {
  return text.includes("\u0000")
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

async function safeStat(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(target)
  } catch {
    return null
  }
}

async function walkFiles(
  root: string,
  startPath: string,
  limit: number,
  contains?: string,
): Promise<WalkResult> {
  const files: WalkResult["files"] = []
  const stack = [startPath]
  const containsLower = contains?.toLowerCase()
  let truncated = false
  let skippedDirs = 0
  let skippedSecret = 0

  while (stack.length > 0) {
    const current = stack.pop() as string
    const stat = await safeStat(current)
    if (!stat) continue

    const name = path.basename(current)
    const displayPath = toDisplayPath(root, current)

    if (stat.isSymbolicLink()) {
      if (stat.isDirectory()) skippedDirs++
      continue
    }
    const realCurrent = await safeRealPath(current)
    if (!realCurrent || !isInside(root, realCurrent)) {
      if (stat.isDirectory()) skippedDirs++
      continue
    }
    if (hasSecretSegment(displayPath)) {
      skippedSecret++
      continue
    }
    if (stat.isDirectory()) {
      if (shouldSkipDirectory(name)) {
        skippedDirs++
        continue
      }

      let entries: string[]
      try {
        entries = await fs.readdir(current)
      } catch {
        continue
      }

      for (const entry of entries.sort().reverse()) {
        stack.push(path.join(current, entry))
      }
      continue
    }

    if (!stat.isFile()) continue
    if (containsLower && !displayPath.toLowerCase().includes(containsLower)) continue

    files.push({ path: displayPath, size: stat.size })
    if (files.length >= limit) {
      truncated = true
      break
    }
  }

  return { files, truncated, skippedDirs, skippedSecret }
}

async function readTextFile(root: string, requestedPath: string, maxBytes: number): Promise<{
  absolutePath: string
  displayPath: string
  text: string
  size: number
}> {
  const absolutePath = await resolveExistingInside(root, requestedPath)
  if (!absolutePath) throw new Error(`Not a readable file: ${requestedPath}`)
  const displayPath = toDisplayPath(root, absolutePath)
  if (hasSecretSegment(displayPath)) throw new Error(`Refusing to read secret-like file: ${displayPath}`)

  const stat = await safeStat(absolutePath)
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Not a readable file: ${displayPath}`)
  if (stat.size > maxBytes) {
    throw new Error(`File is too large for this safe reader: ${displayPath} (${stat.size} bytes)`)
  }

  const text = await fs.readFile(absolutePath, "utf8")
  if (looksBinary(text)) throw new Error(`Refusing to read binary-like file: ${displayPath}`)

  return { absolutePath, displayPath, text, size: stat.size }
}

function roleForPath(displayPath: string): FileEntry["role"] {
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

async function findGuidance(root: string): Promise<string[]> {
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
    const target = resolveInside(root, candidate)
    const stat = await safeStat(target)
    if (!stat || stat.isSymbolicLink()) continue
    const realTarget = await safeRealPath(target)
    if (realTarget && isInside(root, realTarget)) guidance.push(candidate)
  }
  return guidance
}

function addSymbol(
  symbols: SymbolEntry[],
  file: FileEntry,
  line: number,
  kind: SymbolEntry["kind"],
  name: string,
  signature?: string,
): void {
  symbols.push({
    path: file.path,
    line,
    language: file.language,
    kind,
    name,
    signature: signature ? boundedLineText(signature.trim()).text : undefined,
  })
}

function extractSymbols(file: FileEntry, text: string): SymbolEntry[] {
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
        if (match) addSymbol(symbols, file, i + 1, kind, match[1], trimmed)
      }
      continue
    }

    if (file.language === "python") {
      const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)\b/)
      if (classMatch) addSymbol(symbols, file, i + 1, "class", classMatch[1], trimmed)
      const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/)
      if (functionMatch) addSymbol(symbols, file, i + 1, "function", functionMatch[1], trimmed)
      continue
    }

    if (file.language === "java") {
      const typeMatch = trimmed.match(/(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)\b/)
      if (typeMatch) {
        const kind = typeMatch[1] === "record" ? "record" : (typeMatch[1] as SymbolEntry["kind"])
        addSymbol(symbols, file, i + 1, kind, typeMatch[2], trimmed)
        continue
      }
      const methodMatch = trimmed.match(/(?:public|protected|private|static|final|synchronized|abstract|\s)+[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/)
      if (methodMatch && !["catch", "for", "if", "new", "switch", "while"].includes(methodMatch[1])) {
        addSymbol(symbols, file, i + 1, "method", methodMatch[1], trimmed)
      }
    }
  }

  return symbols
}

async function collectSymbols(
  root: string,
  files: FileEntry[],
  limit: number,
  predicate?: (symbol: SymbolEntry) => boolean,
): Promise<{ symbols: SymbolEntry[]; skippedUnreadable: number; truncated: boolean }> {
  const symbols: SymbolEntry[] = []
  let skippedUnreadable = 0
  let truncated = false

  for (const file of files) {
    if (symbols.length >= limit) {
      truncated = true
      break
    }
    if (!SYMBOL_LANGUAGES.has(file.language)) continue
    try {
      const textFile = await readTextFile(root, file.path, DEFAULT_MAX_READ_BYTES)
      const extracted = extractSymbols(file, textFile.text)
      for (const symbol of extracted) {
        if (predicate && !predicate(symbol)) continue
        symbols.push(symbol)
        if (symbols.length >= limit) {
          truncated = true
          break
        }
      }
    } catch {
      skippedUnreadable++
    }
  }

  return { symbols, skippedUnreadable, truncated }
}

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
  return [...imports]
}

function resolveImportPath(fromPath: string, specifier: string, fileSet: Set<string>): string | null {
  const baseDirectory = dirnameOf(fromPath) === "." ? "" : dirnameOf(fromPath)
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

function pushRelated(target: RelatedEntry[], entry: RelatedEntry, seen: Set<string>, maxResults: number): boolean {
  const key = `${entry.reason}:${entry.path}:${entry.detail || ""}`
  if (seen.has(key)) return target.length >= maxResults
  seen.add(key)
  target.push(entry)
  return target.length >= maxResults
}

async function collectRelated(root: string, targetFile: FileEntry, files: FileEntry[], maxResults: number): Promise<{
  directImports: RelatedEntry[]
  importedBy: RelatedEntry[]
  likelyTests: RelatedEntry[]
  sameBasename: RelatedEntry[]
  siblings: RelatedEntry[]
  skippedUnreadable: number
  truncated: boolean
}> {
  const fileSet = new Set(files.map((file) => file.path))
  const seen = new Set<string>()
  const directImports: RelatedEntry[] = []
  const importedBy: RelatedEntry[] = []
  const likelyTests: RelatedEntry[] = []
  const sameBasename: RelatedEntry[] = []
  const siblings: RelatedEntry[] = []
  let skippedUnreadable = 0
  let truncated = false

  if (IMPORT_LANGUAGES.has(targetFile.language)) {
    try {
      const targetText = await readTextFile(root, targetFile.path, DEFAULT_MAX_READ_BYTES)
      for (const specifier of extractRelativeImports(targetText.text)) {
        const resolved = resolveImportPath(targetFile.path, specifier, fileSet)
        if (resolved && pushRelated(directImports, { path: resolved, reason: "direct-import", detail: specifier }, seen, maxResults)) truncated = true
      }
    } catch {
      skippedUnreadable++
    }
  }

  for (const file of files) {
    if (directImports.length + importedBy.length + likelyTests.length + sameBasename.length + siblings.length >= maxResults) {
      truncated = true
      break
    }
    if (file.path === targetFile.path) continue

    if (file.role === "test" && isLikelyTestFor(targetFile, file)) {
      if (pushRelated(likelyTests, { path: file.path, reason: "likely-test" }, seen, maxResults)) truncated = true
    }
    if (stemOf(file.path).toLowerCase() === stemOf(targetFile.path).toLowerCase()) {
      if (pushRelated(sameBasename, { path: file.path, reason: "same-basename" }, seen, maxResults)) truncated = true
    }
    if (dirnameOf(file.path) === dirnameOf(targetFile.path)) {
      if (pushRelated(siblings, { path: file.path, reason: "sibling" }, seen, maxResults)) truncated = true
    }

    if (IMPORT_LANGUAGES.has(file.language)) {
      try {
        const fileText = await readTextFile(root, file.path, DEFAULT_MAX_READ_BYTES)
        for (const specifier of extractRelativeImports(fileText.text)) {
          const resolved = resolveImportPath(file.path, specifier, fileSet)
          if (resolved === targetFile.path && pushRelated(importedBy, { path: file.path, reason: "imported-by", detail: specifier }, seen, maxResults)) truncated = true
        }
      } catch {
        skippedUnreadable++
      }
    }
  }

  return { directImports, importedBy, likelyTests, sameBasename, siblings, skippedUnreadable, truncated }
}

export const RecursiveContextPlugin: Plugin = async () => {
  return {
    tool: {
      context_outline: tool({
        description:
          "Read-only worktree outline for large audits. Lists top-level files and local workflow/skill guidance without reading secrets.",
        args: {},
        async execute(_args, context) {
          const root = await projectRoot(context)
          const top = await walkFiles(root, root, 200)
          const guidance = await findGuidance(root)

          return JSON.stringify(
            {
              worktree: ".",
              guidance,
              filesSample: top.files.slice(0, 80),
              truncated: top.truncated,
              skippedDirs: top.skippedDirs,
              skippedSecret: top.skippedSecret,
              tools: [
                "context_batch_read",
                "context_files",
                "context_map",
                "context_read",
                "context_related",
                "context_search",
                "context_symbols",
              ],
            },
            null,
            2,
          )
        },
      }),

      context_map: tool({
        description:
          "Read-only project map with guidance, manifests, CI files, languages, roles, directories, and optional lightweight symbols.",
        args: {
          path: tool.schema.string().optional().describe("Relative path to map from. Defaults to worktree root."),
          depth: tool.schema.number().int().min(1).max(5).optional().describe("Directory summary depth."),
          limit: tool.schema.number().int().min(1).max(3000).optional().describe("Maximum files to inspect."),
          includeSymbols: tool.schema.boolean().optional().describe("Whether to include a compact symbol sample. Defaults to true."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const startPath = await resolveExistingInside(root, args.path)
          const depth = clampInt(args.depth, 2, 1, 5)
          const limit = clampInt(args.limit, DEFAULT_MAP_LIMIT, 1, 3000)
          if (!startPath) {
            return JSON.stringify(
              {
                worktree: ".",
                path: args.path || ".",
                files: [],
                directories: [],
                guidance: [],
                languages: {},
                roles: {},
                manifests: [],
                ci: [],
                docs: [],
                tests: [],
                truncated: false,
                skippedDirs: 0,
                skippedSecret: 0,
              },
              null,
              2,
            )
          }

          const inventory = await walkFiles(root, startPath, limit)
          const files = inventory.files.map(toFileEntry)
          const includeSymbols = args.includeSymbols ?? true
          const symbolSample = includeSymbols ? await collectSymbols(root, files, 80) : { symbols: [], skippedUnreadable: 0, truncated: false }

          return JSON.stringify(
            {
              worktree: ".",
              path: toDisplayPath(root, startPath),
              guidance: await findGuidance(root),
              files: files.slice(0, 120),
              directories: directorySummary(files, depth).slice(0, 120),
              languages: countBy(files.map((file) => file.language)),
              roles: countBy(files.map((file) => file.role)),
              manifests: files.filter((file) => file.role === "manifest").slice(0, 40),
              ci: files.filter((file) => file.role === "ci").slice(0, 40),
              docs: files.filter((file) => file.role === "doc").slice(0, 40),
              tests: files.filter((file) => file.role === "test").slice(0, 40),
              symbols: symbolSample.symbols,
              truncated: inventory.truncated || symbolSample.truncated,
              skippedDirs: inventory.skippedDirs,
              skippedSecret: inventory.skippedSecret,
              skippedUnreadable: symbolSample.skippedUnreadable,
            },
            null,
            2,
          )
        },
      }),

      context_files: tool({
        description:
          "Read-only file inventory inside the current worktree. Use for broad audits before choosing focused searches or subagents.",
        args: {
          path: tool.schema.string().optional().describe("Relative path to list from. Defaults to worktree root."),
          contains: tool.schema.string().optional().describe("Optional case-insensitive substring filter on file paths."),
          limit: tool.schema.number().int().min(1).max(2000).optional().describe("Maximum files to return."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const startPath = await resolveExistingInside(root, args.path)
          if (!startPath) return JSON.stringify({ files: [], truncated: false, skippedDirs: 0, skippedSecret: 0 }, null, 2)
          const limit = clampInt(args.limit, DEFAULT_FILE_LIMIT, 1, 2000)
          const result = await walkFiles(root, startPath, limit, args.contains)
          return JSON.stringify(result, null, 2)
        },
      }),

      context_batch_read: tool({
        description:
          "Read-only batch line-range reader for multiple non-secret text files inside the current worktree.",
        args: {
          ranges: tool.schema
            .array(
              tool.schema.object({
                path: tool.schema.string().describe("Relative file path to read."),
                startLine: tool.schema.number().int().min(1).optional().describe("1-based start line. Defaults to 1."),
                maxLines: tool.schema.number().int().min(1).max(500).optional().describe("Maximum lines for this file."),
              }),
            )
            .min(1)
            .max(20)
            .describe("Line ranges to read."),
          maxTotalLines: tool.schema.number().int().min(1).max(2000).optional().describe("Total line cap across all ranges."),
          maxBytesPerFile: tool.schema.number().int().min(1024).max(5_000_000).optional().describe("Safety cap per file."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const maxTotalLines = clampInt(args.maxTotalLines, DEFAULT_BATCH_TOTAL_LINES, 1, 2000)
          const maxBytesPerFile = clampInt(args.maxBytesPerFile, DEFAULT_MAX_READ_BYTES, 1024, 5_000_000)
          const results = []
          let usedLines = 0
          let truncated = false

          for (const range of args.ranges) {
            if (usedLines >= maxTotalLines) {
              truncated = true
              results.push({ path: range.path, ok: false, error: "Skipped because maxTotalLines was reached" })
              continue
            }
            try {
              const file = await readTextFile(root, range.path, maxBytesPerFile)
              const lines = file.text.split(/\r?\n/)
              const startLine = clampInt(range.startLine, 1, 1, Math.max(1, lines.length))
              const requestedLines = clampInt(range.maxLines, 160, 1, 500)
              const availableLines = Math.max(0, maxTotalLines - usedLines)
              const maxLines = Math.min(requestedLines, availableLines)
              if (maxLines < requestedLines) truncated = true
              const startIndex = startLine - 1
              const selected = lines.slice(startIndex, startIndex + maxLines)
              usedLines += selected.length
              results.push({
                path: file.displayPath,
                ok: true,
                bytes: file.size,
                startLine,
                endLine: startLine + selected.length - 1,
                totalLines: lines.length,
                truncatedBefore: startLine > 1,
                truncatedAfter: startLine + selected.length - 1 < lines.length,
                text: selected.map((line, index) => `${startLine + index}: ${line}`).join("\n"),
              })
            } catch (error) {
              results.push({ path: range.path, ok: false, error: error instanceof Error ? error.message : "Read failed" })
            }
          }

          return JSON.stringify({ worktree: ".", results, usedLines, maxTotalLines, truncated }, null, 2)
        },
      }),

      context_read: tool({
        description:
          "Read-only line-range reader for a non-secret text file inside the current worktree. Prefer this over dumping whole files.",
        args: {
          path: tool.schema.string().describe("Relative file path to read."),
          startLine: tool.schema.number().int().min(1).optional().describe("1-based start line. Defaults to 1."),
          maxLines: tool.schema.number().int().min(1).max(500).optional().describe("Maximum lines to return."),
          maxBytes: tool.schema.number().int().min(1024).max(5_000_000).optional().describe("Safety cap for file size."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const maxBytes = clampInt(args.maxBytes, DEFAULT_MAX_READ_BYTES, 1024, 5_000_000)
          const file = await readTextFile(root, args.path, maxBytes)
          const lines = file.text.split(/\r?\n/)
          const startLine = clampInt(args.startLine, 1, 1, Math.max(1, lines.length))
          const maxLines = clampInt(args.maxLines, 160, 1, 500)
          const startIndex = startLine - 1
          const selected = lines.slice(startIndex, startIndex + maxLines)
          const numbered = selected.map((line, index) => `${startLine + index}: ${line}`).join("\n")
          const endLine = startLine + selected.length - 1

          return [
            `path: ${file.displayPath}`,
            `bytes: ${file.size}`,
            `lines: ${startLine}-${endLine} of ${lines.length}`,
            `truncatedBefore: ${startLine > 1}`,
            `truncatedAfter: ${endLine < lines.length}`,
            "",
            numbered,
          ].join("\n")
        },
      }),

      context_symbols: tool({
        description:
          "Read-only lightweight symbol discovery for TypeScript, JavaScript, Python, and Java files inside the current worktree.",
        args: {
          path: tool.schema.string().optional().describe("Relative path to scan from. Defaults to worktree root."),
          query: tool.schema.string().optional().describe("Optional case-insensitive substring filter on symbol name or signature."),
          kind: tool.schema.string().optional().describe("Optional symbol kind filter."),
          limit: tool.schema.number().int().min(1).max(1000).optional().describe("Maximum symbols to return."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const startPath = await resolveExistingInside(root, args.path)
          if (!startPath) return JSON.stringify({ worktree: ".", symbols: [], truncated: false, skippedUnreadable: 0 }, null, 2)
          const limit = clampInt(args.limit, DEFAULT_SYMBOL_LIMIT, 1, 1000)
          const inventory = await walkFiles(root, startPath, 3000)
          const files = inventory.files.map(toFileEntry).filter((file) => SYMBOL_LANGUAGES.has(file.language))
          const query = args.query?.toLowerCase()
          const kind = args.kind?.toLowerCase()
          const collected = await collectSymbols(root, files, limit, (symbol) => {
            if (kind && symbol.kind !== kind) return false
            if (!query) return true
            return symbol.name.toLowerCase().includes(query) || (symbol.signature || "").toLowerCase().includes(query)
          })

          return JSON.stringify(
            {
              worktree: ".",
              path: toDisplayPath(root, startPath),
              symbols: collected.symbols,
              truncated: collected.truncated || inventory.truncated,
              skippedUnreadable: collected.skippedUnreadable,
              skippedDirs: inventory.skippedDirs,
              skippedSecret: inventory.skippedSecret,
            },
            null,
            2,
          )
        },
      }),

      context_related: tool({
        description:
          "Read-only related-file discovery for a target file: relative imports, imported-by, likely tests, siblings, and same-basename files.",
        args: {
          path: tool.schema.string().describe("Relative target file path."),
          maxResults: tool.schema.number().int().min(1).max(300).optional().describe("Maximum related entries across all groups."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const target = await readTextFile(root, args.path, DEFAULT_MAX_READ_BYTES)
          const maxResults = clampInt(args.maxResults, DEFAULT_RELATED_LIMIT, 1, 300)
          const inventory = await walkFiles(root, root, 5000)
          const files = inventory.files.map(toFileEntry)
          const targetFile = toFileEntry({ path: target.displayPath, size: target.size })
          const related = await collectRelated(root, targetFile, files, maxResults)

          return JSON.stringify(
            {
              worktree: ".",
              target: target.displayPath,
              directImports: related.directImports,
              importedBy: related.importedBy,
              likelyTests: related.likelyTests,
              sameBasename: related.sameBasename,
              siblings: related.siblings,
              truncated: related.truncated || inventory.truncated,
              skippedUnreadable: related.skippedUnreadable,
              skippedDirs: inventory.skippedDirs,
              skippedSecret: inventory.skippedSecret,
            },
            null,
            2,
          )
        },
      }),

      context_search: tool({
        description:
          "Read-only literal text search inside the current worktree. Skips generated/dependency/cache dirs and secret-like files.",
        args: {
          query: tool.schema.string().min(1).describe("Literal text to search for."),
          path: tool.schema.string().optional().describe("Relative path to search from. Defaults to worktree root."),
          pathContains: tool.schema.string().optional().describe("Optional case-insensitive substring filter on file paths."),
          extensions: tool.schema.array(tool.schema.string()).max(20).optional().describe("Optional file extension filters."),
          contextLines: tool.schema.number().int().min(0).max(3).optional().describe("Context lines before and after each match."),
          caseSensitive: tool.schema.boolean().optional().describe("Defaults to false."),
          maxMatches: tool.schema.number().int().min(1).max(500).optional().describe("Maximum matching lines to return."),
          maxFiles: tool.schema.number().int().min(1).max(5000).optional().describe("Maximum files to scan."),
          maxBytesPerFile: tool.schema.number().int().min(1024).max(5_000_000).optional().describe("Skip files above this size."),
        },
        async execute(args, context) {
          const root = await projectRoot(context)
          const startPath = await resolveExistingInside(root, args.path)
          if (!startPath) {
            return JSON.stringify(
              {
                query: args.query,
                scanned: 0,
                matches: [],
                truncated: false,
                skippedLarge: 0,
                skippedUnreadable: 0,
                skippedDirs: 0,
                skippedSecret: 0,
              },
              null,
              2,
            )
          }
          const maxFiles = clampInt(args.maxFiles, 1500, 1, 5000)
          const maxMatches = clampInt(args.maxMatches, DEFAULT_MATCH_LIMIT, 1, 500)
          const maxBytesPerFile = clampInt(args.maxBytesPerFile, DEFAULT_MAX_READ_BYTES, 1024, 5_000_000)
          const contextLines = clampInt(args.contextLines, 0, 0, 3)
          const extensions = new Set((args.extensions || []).map(normalizeExtension).filter(Boolean))
          const pathContains = args.pathContains?.toLowerCase()
          const inventory = await walkFiles(root, startPath, maxFiles)
          const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
          const matches: Array<{
            path: string
            line: number
            text: string
            textTruncated: boolean
            contextBefore?: Array<{ line: number; text: string; textTruncated: boolean }>
            contextAfter?: Array<{ line: number; text: string; textTruncated: boolean }>
          }> = []
          let skippedLarge = 0
          let skippedUnreadable = 0
          let truncatedMatches = 0
          let truncatedContext = 0
          let scanned = 0

          for (const entry of inventory.files) {
            if (matches.length >= maxMatches) break
            if (pathContains && !entry.path.toLowerCase().includes(pathContains)) continue
            if (extensions.size > 0 && !extensions.has(path.posix.extname(entry.path).toLowerCase())) continue
            if (entry.size > maxBytesPerFile) {
              skippedLarge++
              continue
            }

            try {
              const file = await readTextFile(root, entry.path, maxBytesPerFile)
              scanned++
              const lines = file.text.split(/\r?\n/)
              for (let i = 0; i < lines.length; i++) {
                const haystack = args.caseSensitive ? lines[i] : lines[i].toLowerCase()
                if (!haystack.includes(needle)) continue
                const text = matchText(lines[i], args.query, args.caseSensitive ?? false)
                if (text.truncated) truncatedMatches++
                const match = { path: entry.path, line: i + 1, text: text.text, textTruncated: text.truncated }
                if (contextLines > 0) {
                  const before = lines.slice(Math.max(0, i - contextLines), i)
                  const after = lines.slice(i + 1, i + 1 + contextLines)
                  Object.assign(match, {
                    contextBefore: before.map((line, index) => {
                      const bounded = boundedLineText(line)
                      if (bounded.textTruncated) truncatedContext++
                      return { line: i - before.length + index + 1, ...bounded }
                    }),
                    contextAfter: after.map((line, index) => {
                      const bounded = boundedLineText(line)
                      if (bounded.textTruncated) truncatedContext++
                      return { line: i + index + 2, ...bounded }
                    }),
                  })
                }
                matches.push(match)
                if (matches.length >= maxMatches) break
              }
            } catch {
              skippedUnreadable++
            }
          }

          return JSON.stringify(
            {
              query: args.query,
              scanned,
              matches,
              truncated: matches.length >= maxMatches || inventory.truncated || truncatedMatches > 0 || truncatedContext > 0,
              truncatedMatches,
              truncatedContext,
              skippedLarge,
              skippedUnreadable,
              skippedDirs: inventory.skippedDirs,
              skippedSecret: inventory.skippedSecret,
            },
            null,
            2,
          )
        },
      }),
    },
  }
}

export default RecursiveContextPlugin
