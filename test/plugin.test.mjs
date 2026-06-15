import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
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

async function writeWorkspaceFile(root, relativePath, contents) {
  const absolutePath = path.join(root, ...relativePath.split("/"))
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents, "utf8")
}

async function tools() {
  const hooks = await RecursiveContextPlugin()
  assert.ok(hooks.tool, "plugin should expose tools")
  return hooks.tool
}

function context(root) {
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata() {},
    ask() {
      throw new Error("tests should not ask for permissions")
    },
  }
}

test("context_files lists ordinary files while skipping generated and secret-like paths", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export const value = 1\n")
    await writeWorkspaceFile(root, "docs/readme.md", "# Docs\n")
    await writeWorkspaceFile(root, ".env", "TOKEN=secret\n")
    await writeWorkspaceFile(root, ".ssh/id_rsa", "private-key\n")
    await writeWorkspaceFile(root, "node_modules/pkg/index.js", "module.exports = 1\n")

    const pluginTools = await tools()
    const result = JSON.parse(await pluginTools.context_files.execute({ limit: 100 }, context(root)))
    const paths = new Set(result.files.map((entry) => entry.path))

    assert.equal(result.truncated, false)
    assert.equal(paths.has("src/app.ts"), true)
    assert.equal(paths.has("docs/readme.md"), true)
    assert.equal(paths.has(".env"), false)
    assert.equal(paths.has(".ssh/id_rsa"), false)
    assert.equal(paths.has("node_modules/pkg/index.js"), false)
    assert.ok(result.skippedSecret >= 2, "secret-like paths should be counted")
    assert.ok(result.skippedDirs >= 1, "generated directories should be counted")
  })
})

test("context_read refuses traversal, secret-like files, and binary-like files", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "safe.txt", "hello\n")
    await writeWorkspaceFile(root, ".env", "TOKEN=secret\n")
    await writeWorkspaceFile(root, "binary.txt", `text${String.fromCharCode(0)}tail`)

    const pluginTools = await tools()
    await assert.rejects(
      () => pluginTools.context_read.execute({ path: "../outside.txt" }, context(root)),
      /Path is outside the worktree/,
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

test("context_search supports case sensitivity and bounded excerpts", async () => {
  await withWorkspace(async (root) => {
    const longLine = `${"a".repeat(400)}Needle${"b".repeat(400)}`
    await writeWorkspaceFile(root, "notes.txt", `Alpha\nalpha\n${longLine}\n`)

    const pluginTools = await tools()
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

    assert.equal(insensitive.matches.length, 2)
    assert.deepEqual(
      sensitive.matches.map((match) => match.line),
      [1],
    )
    assert.equal(bounded.matches[0].textTruncated, true)
    assert.ok(bounded.matches[0].text.length <= 326)
    assert.equal(bounded.truncated, true)
  })
})

test("context_read rejects symlinks that resolve outside the worktree when symlinks are available", async (t) => {
  await withWorkspace(async (root) => {
    const outsideRoot = await mkdtemp(path.join(process.cwd(), ".tmp-tests", "outside-"))
    const outsideFile = path.join(outsideRoot, "secret.txt")
    const linkPath = path.join(root, "linked-secret.txt")

    try {
      await writeFile(outsideFile, "outside\n", "utf8")
      await symlink(outsideFile, linkPath, "file")
    } catch (error) {
      await rm(outsideRoot, { recursive: true, force: true })
      t.skip(`symlink unavailable: ${error.code || error.message}`)
      return
    }

    try {
      const pluginTools = await tools()
      await assert.rejects(
        () => pluginTools.context_read.execute({ path: "linked-secret.txt" }, context(root)),
        /Path resolves outside the worktree/,
      )
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})
