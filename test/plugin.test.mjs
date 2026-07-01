import assert from "node:assert/strict"
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { test } from "node:test"
import { RecursiveContextPlugin } from "../dist/index.js"

async function withWorkspace(run) {
  const tempParent = path.join(process.cwd(), ".tmp-tests")
  await mkdir(tempParent, { recursive: true })
  const root = await mkdtemp(path.join(tempParent, "worktree-"))

  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withTwoWorkspaces(run) {
  const tempParent = path.join(process.cwd(), ".tmp-tests")
  await mkdir(tempParent, { recursive: true })
  const alphaRoot = await mkdtemp(path.join(tempParent, "alpha-worktree-"))
  const betaRoot = await mkdtemp(path.join(tempParent, "beta-worktree-"))

  try {
    return await run(alphaRoot, betaRoot)
  } finally {
    await rm(alphaRoot, { recursive: true, force: true })
    await rm(betaRoot, { recursive: true, force: true })
  }
}

async function writeWorkspaceFile(root, relativePath, contents, encoding = "utf8") {
  const absolutePath = path.join(root, ...relativePath.split("/"))
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents, encoding)
}

async function createDirectoryLink(target, linkPath) {
  try {
    await symlink(target, linkPath, "junction")
  } catch {
    await symlink(target, linkPath, "dir")
  }
}

async function tools(options = { toolset: "advanced" }) {
  const hooks = await RecursiveContextPlugin(undefined, options)
  assert.ok(hooks.tool, "plugin should expose tools")
  return hooks.tool
}

async function defaultTools() {
  const hooks = await RecursiveContextPlugin()
  assert.ok(hooks.tool, "plugin should expose default tools")
  return hooks.tool
}

function context(root, signal = new AbortController().signal) {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: root,
    worktree: root,
    abort: signal,
    metadata() {},
    ask() {
      throw new Error("tests should not ask for permissions")
    },
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function assertSchema(result, tool) {
  assert.equal(result.schemaVersion, 2)
  assert.equal(result.tool, tool)
  assert.equal(result.worktree, ".")
  assert.ok(result.snapshot.fingerprint)
  assert.ok(result.coverage)
  assert.ok(result.limits)
  assert.ok(result.usage)
}

test("default toolset is minimal and outline reports only enabled tools", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export const value = 1\n")

    const pluginTools = await defaultTools()
    assert.deepEqual(Object.keys(pluginTools).sort(), ["context_files", "context_outline", "context_read", "context_search"].sort())

    const resultText = await pluginTools.context_outline.execute({}, context(root))
    const result = JSON.parse(resultText)
    assertSchema(result, "context_outline")
    assert.equal(result.worktree, ".")
    assert.deepEqual(result.tools, ["context_outline", "context_files", "context_search", "context_read"])
    assert.equal(resultText.includes(root), false)
  })
})

test("toolsets and enabledTools control exposure", async () => {
  const advanced = await tools({ toolset: "advanced" })
  assert.ok(advanced.context_map)
  assert.ok(advanced.context_related)

  const none = await RecursiveContextPlugin(undefined, { toolset: "none" })
  assert.deepEqual(Object.keys(none.tool), [])

  const explicit = await RecursiveContextPlugin(undefined, {
    toolset: "advanced",
    enabledTools: ["context_read", "context_search", "context_read"],
  })
  assert.deepEqual(Object.keys(explicit.tool), ["context_search", "context_read"])

  await assert.rejects(() => RecursiveContextPlugin(undefined, { enabledTools: ["context_nope"] }), /Unknown tool id/)
})

test("context_files lists ordinary files while skipping generated and secret-like paths", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export const value = 1\n")
    await writeWorkspaceFile(root, "docs/readme.md", "# Docs\n")
    await writeWorkspaceFile(root, ".env", "TOKEN=secret\n")
    await writeWorkspaceFile(root, ".ssh/id_rsa", "private-key\n")
    await writeWorkspaceFile(root, "node_modules/pkg/index.js", "module.exports = 1\n")

    const pluginTools = await defaultTools()
    const result = JSON.parse(await pluginTools.context_files.execute({ limit: 100 }, context(root)))
    const paths = new Set(result.files.map((entry) => entry.path))

    assertSchema(result, "context_files")
    assert.equal(result.truncated, false)
    assert.equal(paths.has("src/app.ts"), true)
    assert.equal(paths.has("docs/readme.md"), true)
    assert.equal(paths.has(".env"), false)
    assert.equal(paths.has(".ssh/id_rsa"), false)
    assert.equal(paths.has("node_modules/pkg/index.js"), false)
    assert.ok(result.coverage.skippedSecret >= 2, "secret-like paths should be counted")
    assert.ok(result.coverage.skippedGenerated >= 1, "generated directories should be counted")
  })
})

test("context_files does not mark exact file limits as truncated", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "only.txt", "one\n")

    const pluginTools = await defaultTools()
    const result = JSON.parse(await pluginTools.context_files.execute({ limit: 1 }, context(root)))

    assert.equal(result.files.length, 1)
    assert.equal(result.coverage.truncation.inventoryLimitReached, false)
    assert.equal(result.coverage.partial, false)
    assert.equal(result.truncated, false)
  })
})

test("context_map summarizes roles, languages, guidance, CI, manifests, and symbols", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "AGENTS.md", "# Agent guidance\n")
    await writeWorkspaceFile(root, "package.json", "{\"name\":\"fixture\"}\n")
    await writeWorkspaceFile(root, ".github/workflows/ci.yml", "name: CI\n")
    await writeWorkspaceFile(root, "README.md", "# Fixture\n")
    await writeWorkspaceFile(root, "src/app.ts", "export class App {}\nexport const mode = \"test\"\n")
    await writeWorkspaceFile(root, "test/app.test.ts", "import { App } from \"../src/app\"\n")

    const pluginTools = await tools()
    const resultText = await pluginTools.context_map.execute({ depth: 2, includeSymbols: true }, context(root))
    const result = JSON.parse(resultText)

    assertSchema(result, "context_map")
    assert.equal(resultText.includes(root), false)
    assert.ok(result.guidance.includes("AGENTS.md"))
    assert.ok(result.manifests.some((entry) => entry.path === "package.json"))
    assert.ok(result.ci.some((entry) => entry.path === ".github/workflows/ci.yml"))
    assert.ok(result.docs.some((entry) => entry.path === "README.md"))
    assert.ok(result.tests.some((entry) => entry.path === "test/app.test.ts"))
    assert.ok(result.languages.typescript >= 2)
    assert.ok(result.roles.source >= 1)
    assert.ok(result.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "App" && symbol.extractor))
    assert.match(result.symbolsCoverage.contentFingerprint, /^[a-f0-9]{64}$/)
  })
})

test("context_batch_read reads multiple ranges with per-item hashes and a total line cap", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "a.txt", "a1\na2\na3\na4\n")
    await writeWorkspaceFile(root, "b.txt", "b1\nb2\nb3\n")
    await writeWorkspaceFile(root, ".env", "TOKEN=secret\n")

    const pluginTools = await tools()
    const result = JSON.parse(
      await pluginTools.context_batch_read.execute(
        {
          ranges: [
            { path: "a.txt", startLine: 2, maxLines: 3 },
            { path: ".env", maxLines: 1 },
            { path: "b.txt", maxLines: 3 },
          ],
          maxTotalLines: 4,
        },
        context(root),
      ),
    )

    assertSchema(result, "context_batch_read")
    assert.equal(result.results[0].ok, true)
    assert.match(result.results[0].sha256, /^[a-f0-9]{64}$/)
    assert.match(result.results[0].text, /2: a2/)
    assert.equal(result.results[1].ok, false)
    assert.match(result.results[1].error, /Refusing secret-like path/)
    assert.equal(result.results[2].ok, true)
    assert.match(result.results[2].text, /1: b1/)
    assert.doesNotMatch(result.results[2].text, /3: b3/)
    assert.equal(result.coverage.truncation.lineLimitReached, true)
  })
})

test("context_read default text output is compatible and json output includes hashes", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "safe.txt", "hello\nworld\n")

    const pluginTools = await defaultTools()
    const text = await pluginTools.context_read.execute({ path: "safe.txt", maxLines: 1 }, context(root))
    assert.match(text, /path: safe\.txt/)
    assert.match(text, /sha256: [a-f0-9]{64}/)
    assert.match(text, /1: hello/)

    const result = JSON.parse(await pluginTools.context_read.execute({ path: "safe.txt", maxLines: 1, format: "json" }, context(root)))
    assertSchema(result, "context_read")
    assert.equal(result.ok, true)
    assert.equal(result.path, "safe.txt")
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
    assert.equal(result.stableDuringRead, true)
    assert.equal(result.selectedRange.startLine, 1)
    assert.equal(result.totalLines, 3)
  })
})

test("context_read and context_batch_read report expected hash mismatches without content", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "safe.txt", "hello\n")
    await writeWorkspaceFile(root, "binary.txt", Buffer.from([0x61, 0x00, 0x62]))

    const pluginTools = await tools()
    const read = JSON.parse(
      await pluginTools.context_read.execute(
        { path: "safe.txt", expectedSha256: "0".repeat(64), format: "json" },
        context(root),
      ),
    )
    assert.equal(read.ok, false)
    assert.equal(read.error, "hash-mismatch")
    assert.equal(Object.hasOwn(read, "text"), false)
    assert.match(read.actualSha256, /^[a-f0-9]{64}$/)

    const batch = JSON.parse(
      await pluginTools.context_batch_read.execute(
        { ranges: [{ path: "safe.txt", expectedSha256: "0".repeat(64) }] },
        context(root),
      ),
    )
    assert.equal(batch.results[0].ok, false)
    assert.equal(batch.results[0].error, "hash-mismatch")
    assert.equal(Object.hasOwn(batch.results[0], "text"), false)

    await assert.rejects(
      () => pluginTools.context_read.execute(
        { path: "binary.txt", expectedSha256: "0".repeat(64), format: "json" },
        context(root),
      ),
      /Refusing to read binary-like file/,
    )

    const binaryBatch = JSON.parse(
      await pluginTools.context_batch_read.execute(
        { ranges: [{ path: "binary.txt", expectedSha256: "0".repeat(64) }] },
        context(root),
      ),
    )
    assert.equal(binaryBatch.results[0].ok, false)
    assert.match(binaryBatch.results[0].error, /Refusing to read binary-like file/)
    assert.equal(Object.hasOwn(binaryBatch.results[0], "actualSha256"), false)
  })
})

test("context_read uses bounded handle reads when a file grows past maxBytes", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "growing.txt", "a".repeat(1024))
    const absolutePath = path.join(root, "growing.txt")
    const probe = await open(absolutePath, "r")
    const fileHandlePrototype = Object.getPrototypeOf(probe)
    await probe.close()

    const originalStat = fileHandlePrototype.stat
    const originalReadFile = fileHandlePrototype.readFile
    let grew = false
    fileHandlePrototype.stat = async function patchedStat(...args) {
      const stat = await originalStat.apply(this, args)
      if (!grew) {
        grew = true
        await writeFile(absolutePath, "a".repeat(2048), "utf8")
      }
      return stat
    }
    fileHandlePrototype.readFile = async function patchedReadFile() {
      throw new Error("unbounded FileHandle.readFile should not be used")
    }

    try {
      const pluginTools = await defaultTools()
      await assert.rejects(
        () => pluginTools.context_read.execute({ path: "growing.txt", maxBytes: 1024, format: "json" }, context(root)),
        /maxBytesPerFile/,
      )
    } finally {
      fileHandlePrototype.stat = originalStat
      fileHandlePrototype.readFile = originalReadFile
    }
  })
})

test("context_batch_read accounts bytes read before a growing file reaches maxTotalBytes", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "growing.txt", "a".repeat(1024))
    const absolutePath = path.join(root, "growing.txt")
    const probe = await open(absolutePath, "r")
    const fileHandlePrototype = Object.getPrototypeOf(probe)
    await probe.close()

    const originalStat = fileHandlePrototype.stat
    const originalReadFile = fileHandlePrototype.readFile
    let grew = false
    fileHandlePrototype.stat = async function patchedStat(...args) {
      const stat = await originalStat.apply(this, args)
      if (!grew) {
        grew = true
        await writeFile(absolutePath, "a".repeat(2048), "utf8")
      }
      return stat
    }
    fileHandlePrototype.readFile = async function patchedReadFile() {
      throw new Error("unbounded FileHandle.readFile should not be used")
    }

    try {
      const hooks = await RecursiveContextPlugin(undefined, {
        toolset: "advanced",
        maxBytesPerFile: 5000,
        maxTotalBytes: 1500,
      })
      const result = JSON.parse(
        await hooks.tool.context_batch_read.execute(
          { ranges: [{ path: "growing.txt" }] },
          context(root),
        ),
      )

      assert.equal(result.results[0].ok, false)
      assert.equal(result.results[0].error, "byte-limit-reached")
      assert.equal(result.results[0].limit, "maxTotalBytes")
      assert.equal(result.usage.bytes, 1500)
      assert.equal(result.coverage.truncation.byteLimitReached, true)
      assert.equal(result.coverage.partial, true)
    } finally {
      fileHandlePrototype.stat = originalStat
      fileHandlePrototype.readFile = originalReadFile
    }
  })
})

test("hash mismatches still consume aggregate byte budget", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "a.txt", "a".repeat(1000))
    await writeWorkspaceFile(root, "b.txt", "b".repeat(1000))

    const hooks = await RecursiveContextPlugin(undefined, {
      toolset: "advanced",
      maxBytesPerFile: 1200,
      maxTotalBytes: 1500,
    })
    const result = JSON.parse(
      await hooks.tool.context_batch_read.execute(
        {
          ranges: [
            { path: "a.txt", expectedSha256: "0".repeat(64) },
            { path: "b.txt", expectedSha256: "0".repeat(64) },
          ],
        },
        context(root),
      ),
    )

    assert.equal(result.results[0].ok, false)
    assert.equal(result.results[0].error, "hash-mismatch")
    assert.equal(result.results[1].ok, false)
    assert.equal(result.results[1].error, "byte-limit-reached")
    assert.equal(result.results[1].limit, "maxTotalBytes")
    assert.equal(result.usage.bytes, 1000)
    assert.equal(result.coverage.truncation.byteLimitReached, true)
    assert.equal(result.coverage.partial, true)
  })
})

test("context_read refuses traversal, absolute paths, secret-like files, and binary-like files", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "safe.txt", "hello\n")
    await writeWorkspaceFile(root, ".env", "TOKEN=secret\n")
    await writeWorkspaceFile(root, "binary.txt", Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00, 0x74]))

    const pluginTools = await defaultTools()
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "../outside.txt" }, context(root)),
      /Path is outside the worktree/,
    )
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: path.join(root, "safe.txt") }, context(root)),
      /Absolute paths are not allowed/,
    )
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: ".env" }, context(root)),
      /Refusing secret-like path/,
    )
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "binary.txt" }, context(root)),
      /Refusing to read binary-like file/,
    )
  })
})

test("UTF-8 handling accepts normal Unicode and rejects malformed/control-heavy binary content", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "unicode.txt", "Привет 👋\r\n")
    await writeWorkspaceFile(root, "bom.txt", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n")]))
    await writeWorkspaceFile(root, "malformed.txt", Buffer.from([0xc3, 0x28]))
    await writeWorkspaceFile(root, "control.txt", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 65]))

    const pluginTools = await defaultTools()
    const unicode = JSON.parse(await pluginTools.context_read.execute({ path: "unicode.txt", format: "json" }, context(root)))
    assert.match(unicode.text, /Привет/)
    const bom = JSON.parse(await pluginTools.context_read.execute({ path: "bom.txt", format: "json" }, context(root)))
    assert.equal(bom.encoding, "utf-8-bom")

    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "malformed.txt" }, context(root)),
      /malformed UTF-8/,
    )
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "control.txt" }, context(root)),
      /control-heavy binary-like file/,
    )
  })
})

test("context_search supports case sensitivity, bounded excerpts, per-file hashes, and multiline rejection", async () => {
  await withWorkspace(async (root) => {
    const longLine = `${"a".repeat(400)}Needle${"b".repeat(400)}`
    await writeWorkspaceFile(root, "notes.txt", `Alpha\nalpha\n${longLine}\n`)

    const pluginTools = await defaultTools()
    const insensitive = JSON.parse(
      await pluginTools.context_search.execute({ query: "alpha", path: "notes.txt" }, context(root)),
    )
    const sensitive = JSON.parse(
      await pluginTools.context_search.execute(
        { query: "Alpha", path: "notes.txt", caseSensitive: true },
        context(root),
      ),
    )
    const bounded = JSON.parse(
      await pluginTools.context_search.execute({ query: "Needle", path: "notes.txt" }, context(root)),
    )

    assertSchema(bounded, "context_search")
    assert.equal(insensitive.matches.length, 2)
    assert.deepEqual(
      sensitive.matches.map((match) => match.line),
      [1],
    )
    assert.equal(bounded.matches[0].textTruncated, true)
    assert.match(bounded.matches[0].fileSha256, /^[a-f0-9]{64}$/)
    assert.equal(bounded.coverage.truncation.excerptTruncated, true)
    assert.equal(bounded.coverage.truncation.coveragePartial, false)
    assert.equal(bounded.coverage.partial, false)
    assert.equal(bounded.snapshot.complete, true)
    assert.equal(bounded.truncated, false)
    await assert.rejects(
      () => pluginTools.context_search.execute({ query: "two\nlines" }, context(root)),
      /Multiline literal search queries are not supported/,
    )
  })
})

test("context_search filters by path and extension and can include bounded context lines", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "aaa.txt", "needle\n")
    await writeWorkspaceFile(root, "src/app.ts", "before\nneedle\n" + "c".repeat(400) + "\n")
    await writeWorkspaceFile(root, "docs/app.md", "needle\n")
    await writeWorkspaceFile(root, "src/app.js", "needle\n")

    const pluginTools = await defaultTools()
    const result = JSON.parse(
      await pluginTools.context_search.execute(
        {
          query: "needle",
          pathContains: "src/",
          extensions: ["ts"],
          contextLines: 1,
          maxFiles: 1,
        },
        context(root),
      ),
    )

    assert.deepEqual(
      result.matches.map((match) => match.path),
      ["src/app.ts"],
    )
    assert.equal(result.matches[0].contextBefore[0].text, "before")
    assert.equal(result.matches[0].contextAfter[0].textTruncated, true)
    assert.equal(result.coverage.truncation.contextAfterTruncated, true)
    assert.equal(result.coverage.truncation.coveragePartial, false)
    assert.equal(result.coverage.partial, false)
    assert.equal(result.snapshot.complete, true)
    assert.equal(result.truncated, false)
  })
})

test("context_search marks coverage partial when candidate files cannot be read", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "text.txt", "haystack\n")
    await writeWorkspaceFile(root, "binary.txt", Buffer.from([0x61, 0x00, 0x62]))

    const pluginTools = await defaultTools()
    const result = JSON.parse(await pluginTools.context_search.execute({ query: "needle" }, context(root)))

    assert.equal(result.matches.length, 0)
    assert.equal(result.coverage.skippedUnreadable, 1)
    assert.equal(result.coverage.partial, true)
    assert.equal(result.coverage.truncation.coveragePartial, true)
    assert.equal(result.snapshot.complete, false)
    assert.equal(result.truncated, true)
  })
})

test("metadata fingerprints are deterministic and change when files change", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export const value = 1\n")

    const pluginTools = await defaultTools()
    const first = JSON.parse(await pluginTools.context_files.execute({}, context(root)))
    const second = JSON.parse(await pluginTools.context_files.execute({}, context(root)))
    assert.equal(first.snapshot.fingerprint, second.snapshot.fingerprint)
    assert.equal(first.snapshot.fingerprintKind, "metadata")

    await writeWorkspaceFile(root, "src/app.ts", "export const value = 22\n")
    const changed = JSON.parse(await pluginTools.context_files.execute({}, context(root)))
    assert.notEqual(first.snapshot.fingerprint, changed.snapshot.fingerprint)
  })
})

test("context_search can reject a stale expected snapshot fingerprint", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "needle\n")

    const pluginTools = await defaultTools()
    const inventory = JSON.parse(await pluginTools.context_files.execute({}, context(root)))
    await writeWorkspaceFile(root, "src/app.ts", "needle changed\n")

    const result = JSON.parse(
      await pluginTools.context_search.execute(
        { query: "needle", expectedSnapshotFingerprint: inventory.snapshot.fingerprint },
        context(root),
      ),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error, "snapshot-mismatch")
    assert.match(result.actualSnapshotFingerprint, /^[a-f0-9]{64}$/)
  })
})

test("context_search accepts the default context_files snapshot on stable large trees", async () => {
  await withWorkspace(async (root) => {
    for (let i = 0; i < 550; i++) {
      await writeWorkspaceFile(root, `src/${String(i).padStart(4, "0")}.txt`, "needle\n")
    }

    const pluginTools = await defaultTools()
    const inventory = JSON.parse(await pluginTools.context_files.execute({}, context(root)))
    const search = JSON.parse(
      await pluginTools.context_search.execute(
        { query: "needle", expectedSnapshotFingerprint: inventory.snapshot.fingerprint },
        context(root),
      ),
    )

    assert.equal(inventory.snapshot.complete, false)
    assert.equal(search.error, undefined)
    assert.equal(search.limits.maxFiles, inventory.limits.maxFiles)
    assert.ok(search.matches.length > 0)
    assert.equal(search.coverage.truncation.inventoryLimitReached, true)
  })
})

test("content tools verify snapshots against stable metadata baselines", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/helper.ts", "export const helper = \"value\"\n")
    await writeWorkspaceFile(root, "src/app.ts", "import { helper } from \"./helper\"\nexport const value = helper\n")

    const pluginTools = await tools()
    const search = JSON.parse(
      await pluginTools.context_search.execute({ query: "helper", requireStableSnapshot: true }, context(root)),
    )
    const symbols = JSON.parse(
      await pluginTools.context_symbols.execute({ query: "value", requireStableSnapshot: true }, context(root)),
    )
    const related = JSON.parse(
      await pluginTools.context_related.execute({ path: "src/app.ts", requireStableSnapshot: true }, context(root)),
    )

    for (const result of [search, symbols, related]) {
      assert.notEqual(result.error, "stale-snapshot")
      assert.equal(result.snapshot.changedDuringOperation, false)
      assert.equal(result.snapshot.stable, true)
    }
  })
})

test("filtered inventory verification uses the same path and extension filters", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "needle\n")
    await writeWorkspaceFile(root, "src/app.js", "needle\n")
    await writeWorkspaceFile(root, "docs/app.md", "needle\n")

    const pluginTools = await defaultTools()
    const files = JSON.parse(await pluginTools.context_files.execute({ contains: "src/", requireStableSnapshot: true }, context(root)))
    const search = JSON.parse(
      await pluginTools.context_search.execute(
        {
          query: "needle",
          pathContains: "src/",
          extensions: ["ts"],
          requireStableSnapshot: true,
        },
        context(root),
      ),
    )

    assert.equal(files.error, undefined)
    assert.equal(files.snapshot.changedDuringOperation, false)
    assert.equal(files.snapshot.stable, true)
    assert.deepEqual(
      files.files.map((entry) => entry.path),
      ["src/app.js", "src/app.ts"],
    )

    assert.equal(search.error, undefined)
    assert.equal(search.snapshot.changedDuringOperation, false)
    assert.equal(search.snapshot.stable, true)
    assert.deepEqual(
      search.matches.map((match) => match.path),
      ["src/app.ts"],
    )
  })
})

test("snapshot verification uses an independent inventory budget", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "a.txt", "a\n")

    const hooks = await RecursiveContextPlugin(undefined, { maxDirectories: 1 })
    const result = JSON.parse(await hooks.tool.context_files.execute({ requireStableSnapshot: true }, context(root)))

    assert.notEqual(result.error, "stale-snapshot")
    assert.equal(result.snapshot.changedDuringOperation, false)
    assert.equal(result.snapshot.stable, true)
    assert.equal(result.usage.directories, 1)
    assert.equal(result.coverage.partial, false)
  })
})

test("host ceilings cannot be raised by caller arguments", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "a.txt", "a\n")
    await writeWorkspaceFile(root, "b.txt", "b\n")
    await writeWorkspaceFile(root, "c.txt", "c\n")

    const pluginTools = await RecursiveContextPlugin(undefined, { maxFiles: 1 })
    const outline = JSON.parse(await pluginTools.tool.context_outline.execute({}, context(root)))
    assert.deepEqual(
      outline.filesSample.map((entry) => entry.path),
      ["a.txt"],
    )
    assert.equal(outline.limits.maxFiles, 1)
    assert.equal(outline.coverage.truncation.inventoryLimitReached, true)

    const stableOutline = JSON.parse(await pluginTools.tool.context_outline.execute({ requireStableSnapshot: true }, context(root)))
    assert.notEqual(stableOutline.error, "stale-snapshot")
    assert.equal(stableOutline.snapshot.changedDuringOperation, false)

    const result = JSON.parse(await pluginTools.tool.context_files.execute({ limit: 100 }, context(root)))
    assert.equal(result.files.length, 1)
    assert.equal(result.limits.maxFiles, 1)
    assert.equal(result.coverage.truncation.inventoryLimitReached, true)
  })
})

test("maxTotalLines host ceiling bounds context_read and context_search", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "safe.txt", "one\ntwo\nneedle\nfour\n")

    const hooks = await RecursiveContextPlugin(undefined, { maxTotalLines: 1 })
    const pluginTools = hooks.tool
    const read = JSON.parse(
      await pluginTools.context_read.execute({ path: "safe.txt", maxLines: 10, format: "json" }, context(root)),
    )
    const search = JSON.parse(await pluginTools.context_search.execute({ query: "needle" }, context(root)))

    assert.equal(read.text, "1: one")
    assert.equal(read.usage.lines, 1)
    assert.equal(read.coverage.truncation.lineLimitReached, true)
    assert.equal(search.matches.length, 0)
    assert.equal(search.usage.lines, 1)
    assert.equal(search.coverage.truncation.lineLimitReached, true)
  })
})

test("exact search and symbol result limits do not mark coverage partial", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/one.ts", "export const onlySymbol = 1\n")
    await writeWorkspaceFile(root, "notes.txt", "needle\n")

    const pluginTools = await tools()
    const exactSymbols = JSON.parse(await pluginTools.context_symbols.execute({ path: "src", limit: 1 }, context(root)))
    assert.equal(exactSymbols.symbols.length, 1)
    assert.equal(exactSymbols.coverage.truncation.symbolLimitReached, false)
    assert.equal(exactSymbols.coverage.partial, false)
    assert.equal(exactSymbols.truncated, false)

    const exactSearch = JSON.parse(await pluginTools.context_search.execute({ path: "notes.txt", query: "needle", maxMatches: 1 }, context(root)))
    assert.equal(exactSearch.matches.length, 1)
    assert.equal(exactSearch.coverage.truncation.matchLimitReached, false)
    assert.equal(exactSearch.coverage.partial, false)
    assert.equal(exactSearch.truncated, false)

    await writeWorkspaceFile(root, "src/two.ts", "export const secondSymbol = 2\n")
    await writeWorkspaceFile(root, "more.txt", "needle\n")

    const overSymbols = JSON.parse(await pluginTools.context_symbols.execute({ path: "src", limit: 1 }, context(root)))
    assert.equal(overSymbols.symbols.length, 1)
    assert.equal(overSymbols.coverage.truncation.symbolLimitReached, true)
    assert.equal(overSymbols.coverage.partial, true)

    const overSearch = JSON.parse(await pluginTools.context_search.execute({ query: "needle", maxMatches: 1 }, context(root)))
    assert.equal(overSearch.matches.length, 1)
    assert.equal(overSearch.coverage.truncation.matchLimitReached, true)
    assert.equal(overSearch.coverage.partial, true)
  })
})

test("additional policy restrictions are additive", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "vendor/pkg.txt", "hidden\n")
    await writeWorkspaceFile(root, "src/app.ts", "visible\n")
    await writeWorkspaceFile(root, "config/private-token.txt", "secret\n")

    const hooks = await RecursiveContextPlugin(undefined, {
      additionalIgnoreDirs: ["vendor"],
      additionalSecretPathPatterns: ["private-token"],
    })
    const pluginTools = hooks.tool
    const files = JSON.parse(await pluginTools.context_files.execute({}, context(root)))
    assert.equal(files.files.some((entry) => entry.path === "vendor/pkg.txt"), false)
    assert.equal(files.files.some((entry) => entry.path === "config/private-token.txt"), false)
    assert.equal(files.files.some((entry) => entry.path === "src/app.ts"), true)
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "config/private-token.txt" }, context(root)),
      /Refusing secret-like path/,
    )
  })
})

test("abort is honored before filesystem work", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export const value = 1\n")
    const controller = new AbortController()
    controller.abort()

    const pluginTools = await defaultTools()
    await assert.rejects(
      () => pluginTools.context_files.execute({}, context(root, controller.signal)),
      (error) => error.name === "AbortError",
    )
  })
})

test("deadline failure is explicit and marks partial coverage", async () => {
  await withWorkspace(async (root) => {
    for (let i = 0; i < 800; i++) {
      await writeWorkspaceFile(root, `src/file-${String(i).padStart(4, "0")}.txt`, "needle\n")
    }

    const pluginTools = await defaultTools()
    const result = JSON.parse(await pluginTools.context_search.execute({ query: "needle", maxDurationMs: 1 }, context(root)))
    if (result.error === "deadline-exceeded") {
      assert.equal(result.coverage.truncation.durationLimitReached, true)
      return
    }
    assert.ok(result.usage.files <= result.limits.maxFiles)
  })
})

test("context_symbols extracts lightweight symbols for TypeScript, Python, and Java", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export interface Config {}\nexport const appMode = \"dev\"\n")
    await writeWorkspaceFile(root, "tools/job.py", "class Job:\n    def run(self):\n        pass\n")
    await writeWorkspaceFile(root, "src/App.java", "public class App {\n  public void start() {}\n}\n")
    await writeWorkspaceFile(root, "styles/app.css", ".app {}\n")

    const pluginTools = await tools()
    const result = JSON.parse(await pluginTools.context_symbols.execute({ query: "app", limit: 20 }, context(root)))
    const names = result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)

    assertSchema(result, "context_symbols")
    assert.ok(names.includes("constant:appMode"))
    assert.ok(names.includes("class:App"))
    assert.equal(result.symbols.some((symbol) => symbol.path.includes("\\")), false)
    assert.ok(result.semanticCoverage.supportedLanguages.includes("typescript"))
    assert.ok(result.coverage.unsupportedLanguages.css >= 1)

    const functions = JSON.parse(await pluginTools.context_symbols.execute({ kind: "function", path: "tools" }, context(root)))
    assert.ok(functions.symbols.some((symbol) => symbol.name === "run"))
  })
})

test("context_related returns heuristic evidence, confidence, filters, and coverage notes", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/index.ts", "import { helper } from \"./helper\"\nexport const projectName = helper\n")
    await writeWorkspaceFile(root, "src/helper.ts", "export const helper = \"value\"\n")
    await writeWorkspaceFile(root, "src/index.test.ts", "import { projectName } from \"./index\"\n")
    await writeWorkspaceFile(root, "src/index.md", "# index docs\n")

    const pluginTools = await tools()
    const indexRelated = JSON.parse(await pluginTools.context_related.execute({ path: "src/index.ts" }, context(root)))
    const helperRelated = JSON.parse(await pluginTools.context_related.execute({ path: "src/helper.ts" }, context(root)))

    assertSchema(indexRelated, "context_related")
    assert.ok(indexRelated.directImports.some((entry) => entry.path === "src/helper.ts" && entry.confidence === "high" && entry.evidence === "./helper"))
    assert.ok(indexRelated.likelyTests.some((entry) => entry.path === "src/index.test.ts" && entry.confidence === "medium"))
    assert.ok(indexRelated.sameBasename.some((entry) => entry.path === "src/index.md" && entry.confidence === "low"))
    assert.ok(indexRelated.siblings.some((entry) => entry.path === "src/helper.ts"))
    assert.ok(helperRelated.importedBy.some((entry) => entry.path === "src/index.ts"))
    assert.ok(indexRelated.semanticCoverage.unsupportedMechanisms.includes("reflection"))

    const highOnly = JSON.parse(
      await pluginTools.context_related.execute(
        { path: "src/index.ts", includeLowConfidence: false, relationshipKinds: ["direct-import"] },
        context(root),
      ),
    )
    assert.deepEqual(
      highOnly.related.map((entry) => entry.relationship),
      ["direct-import"],
    )

    const limited = JSON.parse(await pluginTools.context_related.execute({ path: "src/index.ts", maxResults: 1 }, context(root)))
    assert.equal(limited.related.length, 1)
    assert.equal(limited.coverage.truncation.relationshipLimitReached, true)
  })
})

test("context_related keeps target direct imports under tight line budgets", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "a/before.ts", "const before = 1\nconst beforeAgain = 2\n")
    await writeWorkspaceFile(root, "z/helper.ts", "export const helper = 1\n")
    await writeWorkspaceFile(root, "z/target.ts", "import { helper } from \"./helper\"\nexport const value = helper\n")

    const hooks = await RecursiveContextPlugin(undefined, { toolset: "advanced", maxTotalLines: 1 })
    const result = JSON.parse(
      await hooks.tool.context_related.execute(
        { path: "z/target.ts", relationshipKinds: ["direct-import"] },
        context(root),
      ),
    )

    assert.ok(result.directImports.some((entry) => entry.path === "z/helper.ts" && entry.evidence === "./helper"))
    assert.equal(result.coverage.truncation.lineLimitReached, true)
    assert.equal(result.coverage.partial, true)
    assert.equal(result.semanticCoverage.scannedImportFiles, 1)
  })
})

test("direct file tools refuse generated and dependency paths", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "node_modules/pkg/index.ts", "export const pkg = true\n")
    await writeWorkspaceFile(root, "dist/index.ts", "export const built = true\n")
    const packageLink = path.join(root, "package-link")
    await createDirectoryLink(path.join(root, "node_modules", "pkg"), packageLink)

    const pluginTools = await tools()
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "node_modules/pkg/index.ts" }, context(root)),
      /Refusing generated\/dependency\/cache path/,
    )
    await assert.rejects(
      () => pluginTools.context_related.execute({ path: "dist/index.ts" }, context(root)),
      /Refusing generated\/dependency\/cache path/,
    )

    const batch = JSON.parse(
      await pluginTools.context_batch_read.execute({ ranges: [{ path: "node_modules/pkg/index.ts" }] }, context(root)),
    )
    assert.equal(batch.results[0].ok, false)
    assert.match(batch.results[0].error, /Refusing generated\/dependency\/cache path/)

    try {
      await assert.rejects(
        () => pluginTools.context_read.execute({ path: "package-link/index.ts" }, context(root)),
        /Refusing generated\/dependency\/cache path/,
      )
    } finally {
      await rm(packageLink, { recursive: true, force: true })
    }
  })
})

test("context_read rejects links that resolve outside the worktree", async () => {
  await withWorkspace(async (root) => {
    const outsideRoot = await mkdtemp(path.join(process.cwd(), ".tmp-tests", "outside-"))
    const outsideFile = path.join(outsideRoot, "outside.txt")
    const linkPath = path.join(root, "outside-link")
    let requestedPath = "outside-link/outside.txt"

    try {
      await writeFile(outsideFile, "outside\n", "utf8")
      try {
        await createDirectoryLink(outsideRoot, linkPath)
      } catch {
        requestedPath = "outside-link"
        await symlink(outsideFile, linkPath, "file")
      }
    } catch (error) {
      await rm(outsideRoot, { recursive: true, force: true })
      throw error
    }

    try {
      const pluginTools = await defaultTools()
      await assert.rejects(
        () => pluginTools.context_read.execute({ path: requestedPath }, context(root)),
        /Path resolves outside the worktree/,
      )
    } finally {
      await rm(linkPath, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})

test("context_read rejects broken symlinks and does not expose absolute roots in errors", async () => {
  await withWorkspace(async (root) => {
    const targetRoot = await mkdtemp(path.join(process.cwd(), ".tmp-tests", "broken-target-"))
    const linkPath = path.join(root, "broken-link")
    await createDirectoryLink(targetRoot, linkPath)
    await rm(targetRoot, { recursive: true, force: true })

    const pluginTools = await defaultTools()
    await assert.rejects(
      async () => {
        try {
          await pluginTools.context_read.execute({ path: "broken-link/missing.txt" }, context(root))
        } catch (error) {
          assert.equal(String(error.message).includes(root), false)
          throw error
        }
      },
      /Not a readable file/,
    )
    await rm(linkPath, { recursive: true, force: true })
  })
})

test("all context tools isolate identical relative paths and fingerprints across worktrees", async () => {
  await withTwoWorkspaces(async (alphaRoot, betaRoot) => {
    await writeWorkspaceFile(alphaRoot, "src/index.ts", "export const projectName = \"alpha\"\n")
    await writeWorkspaceFile(alphaRoot, "src/index.test.ts", "import { projectName } from \"./index\"\n")
    await writeWorkspaceFile(betaRoot, "src/index.ts", "export const projectName = \"beta\"\n")
    await writeWorkspaceFile(betaRoot, "src/index.spec.ts", "import { projectName } from \"./index\"\n")

    const pluginTools = await tools()
    const alphaContext = context(alphaRoot)
    const betaContext = context(betaRoot)

    const alphaFiles = JSON.parse(await pluginTools.context_files.execute({}, alphaContext))
    const betaFiles = JSON.parse(await pluginTools.context_files.execute({}, betaContext))
    const betaSearchAlpha = JSON.parse(await pluginTools.context_search.execute({ query: "alpha" }, betaContext))
    const alphaRead = await pluginTools.context_read.execute({ path: "src/index.ts" }, alphaContext)
    const alphaOutlineText = await pluginTools.context_outline.execute({}, alphaContext)
    const alphaMapText = await pluginTools.context_map.execute({}, alphaContext)
    const alphaSymbolsText = await pluginTools.context_symbols.execute({ query: "projectName" }, alphaContext)
    const alphaRelated = JSON.parse(await pluginTools.context_related.execute({ path: "src/index.ts" }, alphaContext))
    const alphaBatch = JSON.parse(
      await pluginTools.context_batch_read.execute({ ranges: [{ path: "src/index.ts", maxLines: 1 }] }, alphaContext),
    )

    assert.ok(alphaFiles.files.some((entry) => entry.path === "src/index.ts"))
    assert.notEqual(alphaFiles.snapshot.fingerprint, betaFiles.snapshot.fingerprint)
    assert.equal(betaSearchAlpha.matches.length, 0)
    assert.match(alphaRead, /alpha/)
    assert.doesNotMatch(alphaRead, /beta/)
    assert.equal(alphaOutlineText.includes(alphaRoot), false)
    assert.equal(alphaOutlineText.includes(betaRoot), false)
    assert.match(alphaMapText, /alpha/)
    assert.doesNotMatch(alphaMapText, /beta/)
    assert.match(alphaSymbolsText, /alpha/)
    assert.doesNotMatch(alphaSymbolsText, /beta/)
    assert.ok(alphaRelated.likelyTests.some((entry) => entry.path === "src/index.test.ts"))
    assert.equal(alphaRelated.likelyTests.some((entry) => entry.path === "src/index.spec.ts"), false)
    assert.match(alphaBatch.results[0].text, /alpha/)
    assert.doesNotMatch(alphaBatch.results[0].text, /beta/)
  })
})

test("content hashes match full file bytes", async () => {
  await withWorkspace(async (root) => {
    const content = "one\ntwo\n"
    await writeWorkspaceFile(root, "safe.txt", content)

    const pluginTools = await defaultTools()
    const result = JSON.parse(await pluginTools.context_read.execute({ path: "safe.txt", format: "json" }, context(root)))
    const bytes = await readFile(path.join(root, "safe.txt"))
    assert.equal(result.sha256, sha256(bytes))
  })
})
