import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import path from "node:path";
import { resolveRootPath, rootPathErrorResponse, SOURCE_EXTENSIONS, isTestFile } from "../helpers/repo.js";

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

function runGit(cmd: string, cwd: string): string {
    try {
        return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`git command failed: ${cmd}\n${message}`);
    }
}

export function getChangedFilePaths(root: string, base?: string): string[] {
    let output: string;

    if (base) {
        // Diff contra una branch/commit específico (ideal para PRs / tickets)
        output = runGit(`git diff --name-only --diff-filter=ACMRT ${base}`, root);
    } else {
        // Staged
        const staged = runGit("git diff --name-only --diff-filter=ACMRT --cached", root);
        // Unstaged
        const unstaged = runGit("git diff --name-only --diff-filter=ACMRT", root);
        // Untracked (nuevos archivos sin git add)
        const untracked = runGit("git ls-files --others --exclude-standard", root);

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

            const allChanged = getChangedFilePaths(root, args.base);

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
