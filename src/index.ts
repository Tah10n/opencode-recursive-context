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

type WalkResult = {
  files: Array<{ path: string; size: number }>
  truncated: boolean
  skippedDirs: number
  skippedSecret: number
}

async function projectRoot(context: { worktree?: string; directory: string }): Promise<string> {
  return await fs.realpath(path.resolve(context.worktree || context.directory))
}

function toDisplayPath(root: string, absolutePath: string): string {
  const rel = path.relative(root, absolutePath)
  return rel ? rel.split(path.sep).join("/") : "."
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
          const guidanceCandidates = [
            "AGENTS.md",
            "WORKFLOW.md",
            ".opencode/skills/project/SKILL.md",
            ".opencode/skills/tests/SKILL.md",
            ".opencode/skills/release/SKILL.md",
            ".agents/skills",
          ]

          const guidance = []
          for (const candidate of guidanceCandidates) {
            const target = resolveInside(root, candidate)
            const stat = await safeStat(target)
            if (!stat || stat.isSymbolicLink()) continue
            const realTarget = await safeRealPath(target)
            if (realTarget && isInside(root, realTarget)) guidance.push(candidate)
          }

          return JSON.stringify(
            {
              root,
              guidance,
              filesSample: top.files.slice(0, 80),
              truncated: top.truncated,
              skippedDirs: top.skippedDirs,
              skippedSecret: top.skippedSecret,
              tools: ["context_files", "context_search", "context_read"],
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

      context_search: tool({
        description:
          "Read-only literal text search inside the current worktree. Skips generated/dependency/cache dirs and secret-like files.",
        args: {
          query: tool.schema.string().min(1).describe("Literal text to search for."),
          path: tool.schema.string().optional().describe("Relative path to search from. Defaults to worktree root."),
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
          const inventory = await walkFiles(root, startPath, maxFiles)
          const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
          const matches: Array<{ path: string; line: number; text: string; textTruncated: boolean }> = []
          let skippedLarge = 0
          let skippedUnreadable = 0
          let truncatedMatches = 0
          let scanned = 0

          for (const entry of inventory.files) {
            if (matches.length >= maxMatches) break
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
                matches.push({ path: entry.path, line: i + 1, text: text.text, textTruncated: text.truncated })
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
              truncated: matches.length >= maxMatches || inventory.truncated || truncatedMatches > 0,
              truncatedMatches,
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
