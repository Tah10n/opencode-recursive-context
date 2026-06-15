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

test("context_outline does not expose the absolute worktree path", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export const value = 1\n")

    const pluginTools = await tools()
    const resultText = await pluginTools.context_outline.execute({}, context(root))
    const result = JSON.parse(resultText)

    assert.equal(result.worktree, ".")
    assert.equal(Object.hasOwn(result, "root"), false)
    assert.equal(resultText.includes(root), false)
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

    assert.equal(result.worktree, ".")
    assert.equal(resultText.includes(root), false)
    assert.ok(result.guidance.includes("AGENTS.md"))
    assert.ok(result.manifests.some((entry) => entry.path === "package.json"))
    assert.ok(result.ci.some((entry) => entry.path === ".github/workflows/ci.yml"))
    assert.ok(result.docs.some((entry) => entry.path === "README.md"))
    assert.ok(result.tests.some((entry) => entry.path === "test/app.test.ts"))
    assert.ok(result.languages.typescript >= 2)
    assert.ok(result.roles.source >= 1)
    assert.ok(result.symbols.some((symbol) => symbol.kind === "class" && symbol.name === "App"))
  })
})

test("context_batch_read reads multiple ranges with per-item failures and a total line cap", async () => {
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

    assert.equal(result.worktree, ".")
    assert.equal(result.results[0].ok, true)
    assert.match(result.results[0].text, /2: a2/)
    assert.equal(result.results[1].ok, false)
    assert.match(result.results[1].error, /Refusing secret-like path/)
    assert.equal(result.results[2].ok, true)
    assert.match(result.results[2].text, /1: b1/)
    assert.doesNotMatch(result.results[2].text, /3: b3/)
    assert.equal(result.truncated, true)
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

test("context_search filters by path and extension and can include bounded context lines", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "aaa.txt", "needle\n")
    await writeWorkspaceFile(root, "src/app.ts", "before\nneedle\n" + "c".repeat(400) + "\n")
    await writeWorkspaceFile(root, "docs/app.md", "needle\n")
    await writeWorkspaceFile(root, "src/app.js", "needle\n")

    const pluginTools = await tools()
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
    assert.equal(result.truncatedContext, 1)
  })
})

test("context_symbols extracts lightweight symbols for TypeScript, Python, and Java", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/app.ts", "export interface Config {}\nexport const appMode = \"dev\"\n")
    await writeWorkspaceFile(root, "tools/job.py", "class Job:\n    def run(self):\n        pass\n")
    await writeWorkspaceFile(root, "src/App.java", "public class App {\n  public void start() {}\n}\n")

    const pluginTools = await tools()
    const result = JSON.parse(await pluginTools.context_symbols.execute({ query: "app", limit: 20 }, context(root)))
    const names = result.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)

    assert.equal(result.worktree, ".")
    assert.ok(names.includes("constant:appMode"))
    assert.ok(names.includes("class:App"))
    assert.equal(result.symbols.some((symbol) => symbol.path.includes("\\")), false)

    const functions = JSON.parse(await pluginTools.context_symbols.execute({ kind: "function", path: "tools" }, context(root)))
    assert.ok(functions.symbols.some((symbol) => symbol.name === "run"))
  })
})

test("context_related finds imports, imported-by files, likely tests, siblings, and same-basename files", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "src/index.ts", "import { helper } from \"./helper\"\nexport const projectName = helper\n")
    await writeWorkspaceFile(root, "src/helper.ts", "export const helper = \"value\"\n")
    await writeWorkspaceFile(root, "src/index.test.ts", "import { projectName } from \"./index\"\n")
    await writeWorkspaceFile(root, "src/index.md", "# index docs\n")

    const pluginTools = await tools()
    const indexRelated = JSON.parse(await pluginTools.context_related.execute({ path: "src/index.ts" }, context(root)))
    const helperRelated = JSON.parse(await pluginTools.context_related.execute({ path: "src/helper.ts" }, context(root)))

    assert.equal(indexRelated.worktree, ".")
    assert.ok(indexRelated.directImports.some((entry) => entry.path === "src/helper.ts"))
    assert.ok(indexRelated.likelyTests.some((entry) => entry.path === "src/index.test.ts"))
    assert.ok(indexRelated.sameBasename.some((entry) => entry.path === "src/index.md"))
    assert.ok(indexRelated.siblings.some((entry) => entry.path === "src/helper.ts"))
    assert.ok(helperRelated.importedBy.some((entry) => entry.path === "src/index.ts"))

    const limited = JSON.parse(await pluginTools.context_related.execute({ path: "src/index.ts", maxResults: 1 }, context(root)))
    const limitedCount =
      limited.directImports.length +
      limited.importedBy.length +
      limited.likelyTests.length +
      limited.sameBasename.length +
      limited.siblings.length
    assert.equal(limitedCount, 1)
    assert.equal(limited.truncated, true)
  })
})

test("direct file tools refuse generated and dependency paths", async () => {
  await withWorkspace(async (root) => {
    await writeWorkspaceFile(root, "node_modules/pkg/index.ts", "export const pkg = true\n")
    await writeWorkspaceFile(root, "dist/index.ts", "export const built = true\n")

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

test("all context tools isolate identical relative paths across worktrees", async () => {
  await withTwoWorkspaces(async (alphaRoot, betaRoot) => {
    await writeWorkspaceFile(alphaRoot, "src/index.ts", "export const projectName = \"alpha\"\n")
    await writeWorkspaceFile(alphaRoot, "src/index.test.ts", "import { projectName } from \"./index\"\n")
    await writeWorkspaceFile(betaRoot, "src/index.ts", "export const projectName = \"beta\"\n")
    await writeWorkspaceFile(betaRoot, "src/index.spec.ts", "import { projectName } from \"./index\"\n")

    const pluginTools = await tools()
    const alphaContext = context(alphaRoot)
    const betaContext = context(betaRoot)

    const alphaFiles = JSON.parse(await pluginTools.context_files.execute({}, alphaContext))
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
