import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { resolveRootPath, rootPathErrorResponse, SOURCE_EXTENSIONS, isTestFile } from "../helpers/repo.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GetChangedFilesSchema = z.object({
    rootPath: z
        .string()
        .min(1)
        .describe("Absolute path to the repository root (workspace folder)."),
    base: z
        .string()
        .optional()
        .describe(
            "Base branch or commit to diff against (e.g. 'main', 'HEAD~1'). " +
            "If omitted, returns staged + unstaged changes in the working tree."
        ),
    includeTests: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "If true, includes test files in the result. " +
            "Default false — we only want source files that need tests written for them."
        ),
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Runs a git command asynchronously. Throws on non-zero exit.
 */
async function runGit(cmd: string, cwd: string): Promise<string> {
    try {
        const { stdout } = await execAsync(cmd, {
            cwd,
            encoding: "utf-8",
            timeout: 30_000,
        });
        return stdout.trim();
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const message = e.message ?? String(err);
        throw new Error(`git command failed: ${cmd}\n${message}`);
    }
}

/**
 * Returns absolute paths of changed files.
 * When no `base` is given, runs staged/unstaged/untracked queries in parallel
 * to avoid blocking the event loop sequentially.
 */
export async function getChangedFilePaths(root: string, base?: string): Promise<string[]> {
    let output: string;

    if (base) {
        // Diff contra una branch/commit específico (ideal para PRs / tickets)
        output = await runGit(`git diff --name-only --diff-filter=ACMRT ${base}`, root);
    } else {
        // Run staged, unstaged and untracked queries in parallel
        const [staged, unstaged, untracked] = await Promise.all([
            runGit("git diff --name-only --diff-filter=ACMRT --cached", root),
            runGit("git diff --name-only --diff-filter=ACMRT", root),
            runGit("git ls-files --others --exclude-standard", root),
        ]);

        output = [staged, unstaged, untracked].filter(Boolean).join("\n");
    }

    // Deduplicar y normalizar a rutas absolutas
    const unique = [...new Set(output.split("\n").filter(Boolean))];
    return unique.map((f) => path.resolve(root, f));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerGetChangedFiles(server: McpServer) {
    server.registerTool(
        "get_changed_files",
        {
            title: "Get Changed Files",
            description:
                "Step 2 — Lists source files modified in the current working tree or " +
                "against a base branch (e.g. 'main'). Filters out non-source files " +
                "and optionally test files. Use the returned file paths as input " +
                "for 'run_coverage' and 'read_source_files'.",
            inputSchema: GetChangedFilesSchema,
        },
        async (args) => {
            console.error("[get_changed_files] args:", JSON.stringify(args));

            const resolved = resolveRootPath(args.rootPath);
            if (!resolved.ok) return rootPathErrorResponse(resolved);

            const root = resolved.root;

            const allChanged = await getChangedFilePaths(root, args.base);

            // Filtrar: solo extensiones de código fuente
            const sourceFiles = allChanged.filter((f) => {
                const ext = path.extname(f);
                if (!SOURCE_EXTENSIONS.has(ext)) return false;
                if (!args.includeTests && isTestFile(f)) return false;
                return true;
            });

            const testFiles = allChanged.filter((f) => isTestFile(f) && SOURCE_EXTENSIONS.has(path.extname(f)));

            const result = {
                root,
                base: args.base ?? "(working tree)",
                totalChanged: allChanged.length,
                sourceFiles,
                testFiles,
                summary:
                    sourceFiles.length === 0
                        ? "No source files changed. Nothing to test."
                        : `Found ${sourceFiles.length} changed source file(s). ` +
                          `Run 'run_coverage' to see current test coverage.`,
            };

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
    );
}
