import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { resolveRootPath, rootPathErrorResponse } from "../helpers/repo.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RunCoverageSchema = z.object({
    rootPath: z
        .string()
        .min(1)
        .describe("Absolute path to the repository root (workspace folder)."),
    files: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "List of absolute paths to the source files to measure coverage for. " +
            "Use the output of 'get_changed_files' here."
        ),
    testRunner: z
        .enum(["jest", "vitest"])
        .optional()
        .default("jest")
        .describe("Test runner to use. Defaults to 'jest'."),
    testPathPattern: z
        .string()
        .optional()
        .describe(
            "Optional regex pattern to filter which test files to run " +
            "(passed to jest --testPathPattern or vitest --reporter). " +
            "If omitted, jest/vitest auto-discovers tests for the given files."
        ),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileCoverageMetrics {
    statements:  { total: number; covered: number; skipped: number; pct: number };
    branches:    { total: number; covered: number; skipped: number; pct: number };
    functions:   { total: number; covered: number; skipped: number; pct: number };
    lines:       { total: number; covered: number; skipped: number; pct: number };
}

interface CoverageResult {
    success: boolean;
    testRunner: string;
    files: string[];
    /** Métricas estructuradas leídas de coverage-summary.json (jest) */
    metrics: Record<string, FileCoverageMetrics> | null;
    /** Resumen agregado de todas las métricas */
    aggregated: FileCoverageMetrics | null;
    /** Tabla de texto plana para referencia visual */
    coverageOutput: string;
    summary: string;
    error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRelative(root: string, files: string[]): string[] {
    return files.map((f) => path.relative(root, f));
}

/**
 * Runs a coverage shell command asynchronously, capturing stdout+stderr.
 * Returns structured output regardless of exit code so callers
 * can decide how to handle test failures vs infrastructure errors.
 * Uses execAsync (promisified exec) to avoid blocking the event loop.
 */
async function execCoverage(cmd: string, root: string): Promise<{
    output: string;
    success: boolean;
    errorMsg?: string | undefined;
}> {
    try {
        const { stdout, stderr } = await execAsync(cmd, {
            cwd: root,
            encoding: "utf-8",
            timeout: 180_000,
            maxBuffer: 10 * 1024 * 1024, // 10 MB
        });
        return { output: stdout + (stderr ? "\n" + stderr : ""), success: true };
    } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return {
            output: (e.stdout ?? "") + "\n" + (e.stderr ?? ""),
            success: false,
            errorMsg: e.message,
        };
    }
}

/**
 * Lee coverage/coverage-summary.json generado por jest --coverageReporters=json-summary
 * y devuelve las métricas por archivo filtradas a los archivos objetivo.
 */
function readCoverageSummaryJson(
    root: string,
    relFiles: string[]
): { metrics: Record<string, FileCoverageMetrics>; aggregated: FileCoverageMetrics } | null {
    const summaryPath = path.join(root, "coverage", "coverage-summary.json");
    if (!fs.existsSync(summaryPath)) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(summaryPath, "utf-8")) as Record<string, FileCoverageMetrics & { total?: FileCoverageMetrics }>;

        const metrics: Record<string, FileCoverageMetrics> = {};

        for (const relFile of relFiles) {
            // jest guarda las rutas con separador del OS, buscar con y sin ./
            const absFile = path.resolve(root, relFile);
            const entry = raw[absFile] ?? raw["./" + relFile] ?? raw[relFile];
            if (entry) {
                metrics[relFile] = {
                    statements: entry.statements,
                    branches:   entry.branches,
                    functions:  entry.functions,
                    lines:      entry.lines,
                };
            }
        }

        // Calcular agregado (total de todos los archivos medidos)
        const aggregated = aggregateMetrics(Object.values(metrics));

        return { metrics, aggregated };
    } catch {
        return null;
    }
}

function aggregateMetrics(list: FileCoverageMetrics[]): FileCoverageMetrics {
    const zero = () => ({ total: 0, covered: 0, skipped: 0, pct: 0 });
    const agg: FileCoverageMetrics = {
        statements: zero(), branches: zero(), functions: zero(), lines: zero(),
    };

    for (const m of list) {
        for (const key of ["statements", "branches", "functions", "lines"] as const) {
            agg[key].total   += m[key].total;
            agg[key].covered += m[key].covered;
            agg[key].skipped += m[key].skipped;
        }
    }

    for (const key of ["statements", "branches", "functions", "lines"] as const) {
        const { total, covered } = agg[key];
        agg[key].pct = total === 0 ? 100 : Math.round((covered / total) * 10000) / 100;
    }

    return agg;
}

async function runJestCoverage(
    root: string,
    relFiles: string[],
    testPathPattern?: string
): Promise<CoverageResult> {
    const collectFrom = relFiles.map((f) => `"${f}"`).join(",");
    const pattern = testPathPattern ? `--testPathPattern="${testPathPattern}"` : "";

    const cmd = [
        "npx jest",
        "--coverage",
        "--coverageReporters=text",
        "--coverageReporters=json-summary",
        `--collectCoverageFrom='[${collectFrom}]'`,
        "--passWithNoTests",
        pattern,
    ]
        .filter(Boolean)
        .join(" ");

    console.error("[run_coverage] jest cmd:", cmd);

    const { output, success, errorMsg } = await execCoverage(cmd, root);
    const jsonMetrics = readCoverageSummaryJson(root, relFiles);

    return {
        success,
        testRunner: "jest",
        files: relFiles,
        metrics: jsonMetrics?.metrics ?? null,
        aggregated: jsonMetrics?.aggregated ?? null,
        coverageOutput: output.slice(0, 4000),
        summary: buildSummary(jsonMetrics?.aggregated ?? null, relFiles, jsonMetrics?.metrics ?? null),
        error: errorMsg,
    };
}

async function runVitestCoverage(
    root: string,
    relFiles: string[],
    testPathPattern?: string
): Promise<CoverageResult> {
    const pattern = testPathPattern ? testPathPattern : "";

    const cmd = [
        "npx vitest run",
        "--coverage",
        "--coverage.reporter=json-summary",
        "--reporter=verbose",
        pattern,
    ]
        .filter(Boolean)
        .join(" ");

    console.error("[run_coverage] vitest cmd:", cmd);

    const { output, success, errorMsg } = await execCoverage(cmd, root);

    // vitest también puede generar coverage-summary.json con el reporter json-summary
    const jsonMetrics = readCoverageSummaryJson(root, relFiles);

    return {
        success,
        testRunner: "vitest",
        files: relFiles,
        metrics: jsonMetrics?.metrics ?? null,
        aggregated: jsonMetrics?.aggregated ?? null,
        coverageOutput: output.slice(0, 4000),
        summary: buildSummary(jsonMetrics?.aggregated ?? null, relFiles, jsonMetrics?.metrics ?? null),
        error: errorMsg,
    };
}

function buildSummary(
    aggregated: FileCoverageMetrics | null,
    files: string[],
    metrics: Record<string, FileCoverageMetrics> | null,
): string {
    if (!aggregated) {
        return `Coverage ran for ${files.length} file(s) but no structured metrics were found. ` +
               `Check the coverageOutput field for the raw text output.`;
    }

    const lines: string[] = [
        `Coverage for ${files.length} file(s):`,
        `  Statements : ${aggregated.statements.pct}%  (${aggregated.statements.covered}/${aggregated.statements.total})`,
        `  Branches   : ${aggregated.branches.pct}%  (${aggregated.branches.covered}/${aggregated.branches.total})`,
        `  Functions  : ${aggregated.functions.pct}%  (${aggregated.functions.covered}/${aggregated.functions.total})`,
        `  Lines      : ${aggregated.lines.pct}%  (${aggregated.lines.covered}/${aggregated.lines.total})`,
    ];

    if (metrics) {
        const uncovered = Object.entries(metrics)
            .filter(([, m]) => m.lines.pct < 100)
            .map(([file, m]) => `  ${file}: lines ${m.lines.pct}%, branches ${m.branches.pct}%`);
        if (uncovered.length > 0) {
            lines.push("", "Files with incomplete coverage:");
            lines.push(...uncovered);
        }
    }

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerRunCoverage(server: McpServer) {
    server.registerTool(
        "run_coverage",
        {
            title: "Run Coverage",
            description:
                "Step 3 — Runs jest/vitest with coverage enabled, scoped only to the " +
                "source files provided. Returns structured per-file metrics (statements, " +
                "branches, functions, lines) as numbers, plus an aggregated summary. " +
                "Use the 'metrics' field to identify exactly which files need more tests.",
            inputSchema: RunCoverageSchema,
        },
        async (args) => {
            console.error("[run_coverage] args:", JSON.stringify({ ...args, files: `[${args.files.length} files]` }));

            const resolved = resolveRootPath(args.rootPath);
            if (!resolved.ok) return rootPathErrorResponse(resolved);

            const root = resolved.root;
            const relFiles = toRelative(root, args.files);

            const result = await (
                args.testRunner === "vitest"
                    ? runVitestCoverage(root, relFiles, args.testPathPattern)
                    : runJestCoverage(root, relFiles, args.testPathPattern)
            );

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
    );
}
