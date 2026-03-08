/**
 * Tool: plan
 *
 * Punto de entrada recomendado del flujo. Corre análisis de solo-lectura
 * (project_info + get_changed_files + detección de tests existentes) y
 * devuelve un plan de trabajo estructurado que el modelo debe presentar
 * al usuario para su aprobación ANTES de ejecutar cualquier escritura.
 *
 * El modelo NO debe ejecutar write_test_file hasta que el usuario confirme
 * el plan devuelto por este tool.
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRootPath, rootPathErrorResponse, isTestFile, SOURCE_EXTENSIONS, findTestFileForSource, suggestTestFilePath, detectTestConvention } from "../helpers/repo.js";
import { projectInfoAt } from "./project-info.js";
import { getChangedFilePaths } from "./get-changed-files.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PlanSchema = {
    rootPath: z
        .string()
        .describe(
            "Absolute path to the repository root. Must be provided explicitly."
        ),
    base: z
        .string()
        .optional()
        .describe(
            "Base branch or commit to diff against (e.g. 'main', 'HEAD~1'). " +
            "If omitted, uses staged + unstaged + untracked changes."
        ),
    files: z
        .array(z.string())
        .optional()
        .describe(
            "Explicit list of source files to plan tests for. " +
            "If provided, skips git diff and uses this list directly."
        ),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActionKind = "create_test" | "update_test" | "no_action";

interface FilePlan {
    sourceFile: string;
    relSourceFile: string;
    action: ActionKind;
    reason: string;
    testFile: string | null;
    relTestFile: string | null;
    /** Path where the test will be written (existing or suggested) */
    targetTestPath: string;
    relTargetTestPath: string;
    /** Whether tsc validation will run before writing */
    willValidate: boolean;
}

interface WorkPlan {
    root: string;
    projectName: string | null;
    framework: string;
    testRunner: string;
    coverageThresholds: Record<string, number> | null;
    base: string;
    totalChangedFiles: number;
    filePlans: FilePlan[];
    /** Files skipped because they already have tests and no changes to source */
    skipped: Array<{ file: string; reason: string }>;
    summary: string;
    /** Ordered list of tool calls the model will execute upon confirmation */
    executionSteps: Array<{
        step: number;
        tool: string;
        description: string;
        args: Record<string, unknown>;
    }>;
    /** Message to present to the user asking for confirmation */
    confirmationPrompt: string;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function buildFilePlans(
    changedSources: string[],
    root: string,
    convention: ReturnType<typeof detectTestConvention>
): { plans: FilePlan[]; skipped: WorkPlan["skipped"] } {
    const plans: FilePlan[] = [];
    const skipped: WorkPlan["skipped"] = [];

    const hasTsConfig =
        fs.existsSync(path.join(root, "tsconfig.json")) ||
        fs.existsSync(path.join(root, "tsconfig.base.json"));

    for (const srcFile of changedSources) {
        const relSrc = path.relative(root, srcFile);

        // Buscar test existente
        const existing = findTestFileForSource(srcFile, root);
        const suggested = suggestTestFilePath(srcFile, root, convention);

        const targetTestPath = existing ?? suggested;
        const relTarget = path.relative(root, targetTestPath);

        const ext = path.extname(srcFile);
        const willValidate = hasTsConfig && (ext === ".ts" || ext === ".tsx");

        plans.push({
            sourceFile: srcFile,
            relSourceFile: relSrc,
            action: existing ? "update_test" : "create_test",
            reason: existing
                ? "Source file changed and test file already exists — update tests to cover new changes."
                : "No test file found for this source file — a new test file will be created.",
            testFile: existing,
            relTestFile: existing ? path.relative(root, existing) : null,
            targetTestPath,
            relTargetTestPath: relTarget,
            willValidate,
        });
    }

    return { plans, skipped };
}

function buildExecutionSteps(
    plan: Pick<WorkPlan, "root" | "filePlans" | "testRunner">,
    base: string | undefined
): WorkPlan["executionSteps"] {
    const steps: WorkPlan["executionSteps"] = [];
    let stepNum = 1;

    const sourceFiles = plan.filePlans.map((p) => p.sourceFile);

    steps.push({
        step: stepNum++,
        tool: "get_test_guidelines",
        description: "Fetch framework-specific testing rules for this project.",
        args: { rootPath: plan.root },
    });

    steps.push({
        step: stepNum++,
        tool: "run_coverage",
        description: `Measure baseline coverage for ${sourceFiles.length} file(s).`,
        args: { rootPath: plan.root, files: sourceFiles, testRunner: plan.testRunner },
    });

    steps.push({
        step: stepNum++,
        tool: "read_source_files",
        description: "Read source code + existing tests + import analysis for all files.",
        args: { rootPath: plan.root, files: sourceFiles },
    });

    // Per-file steps
    for (const fp of plan.filePlans) {
        if (fp.action === "no_action") continue;

        // get_test_context for complex files (> 0 relative imports is assumed — will check at runtime)
        steps.push({
            step: stepNum++,
            tool: "get_test_context",
            description: `Extract type dependencies for ${fp.relSourceFile}.`,
            args: { rootPath: plan.root, files: [fp.sourceFile] },
        });

        steps.push({
            step: stepNum++,
            tool: "write_test_file",
            description:
                fp.action === "create_test"
                    ? `Create new test file at ${fp.relTargetTestPath}.`
                    : `Update existing test file at ${fp.relTargetTestPath}.`,
            args: {
                rootPath: plan.root,
                filePath: fp.targetTestPath,
                content: "<generated by model after reading source>",
                overwrite: fp.action === "update_test",
                validate: fp.willValidate,
            },
        });
    }

    steps.push({
        step: stepNum++,
        tool: "run_coverage",
        description: "Re-run coverage to confirm improvement after writing tests.",
        args: { rootPath: plan.root, files: sourceFiles, testRunner: plan.testRunner },
    });

    return steps;
}

function buildConfirmationPrompt(filePlans: FilePlan[], projectName: string | null): string {
    const creates = filePlans.filter((p) => p.action === "create_test");
    const updates = filePlans.filter((p) => p.action === "update_test");

    const lines: string[] = [
        `📋 **Test Plan${projectName ? ` for ${projectName}` : ""}**`,
        ``,
    ];

    if (creates.length > 0) {
        lines.push(`✨ **New test files to create (${creates.length}):**`);
        for (const p of creates) {
            lines.push(`  - \`${p.relTargetTestPath}\`  ← source: \`${p.relSourceFile}\``);
        }
        lines.push("");
    }

    if (updates.length > 0) {
        lines.push(`✏️  **Existing test files to update (${updates.length}):**`);
        for (const p of updates) {
            lines.push(`  - \`${p.relTargetTestPath}\`  ← source: \`${p.relSourceFile}\``);
        }
        lines.push("");
    }

    lines.push(
        `The plan will: measure baseline coverage → read all source files → ` +
        `generate tests with TypeScript validation → re-run coverage to confirm improvement.`,
        ``,
        `**Shall I proceed?** (yes / no, or ask me to adjust the plan first)`
    );

    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerPlan(server: McpServer): void {
    server.registerTool(
        "plan",
        {
            description:
                "Step 0 — ALWAYS call this first. Runs read-only analysis (project setup, " +
                "git diff, test file detection) and returns a structured work plan showing " +
                "exactly which test files will be created or updated and in what order. " +
                "Present the plan to the user and wait for confirmation before executing " +
                "any write operations. Do NOT call write_test_file before the user approves the plan.",
            inputSchema: PlanSchema,
        },
        async (args) => {
            // --- Validate rootPath ---
            const rootResult = resolveRootPath(args.rootPath);
            if (!rootResult.ok) return rootPathErrorResponse(rootResult);
            const root = rootResult.root;

            // --- Project info ---
            const info = projectInfoAt(root);
            if (!info.ready) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    success: false,
                                    error: info.message,
                                    hint: "Fix the reported issues and call plan again.",
                                },
                                null,
                                2
                            ),
                        },
                    ],
                    isError: true,
                };
            }

            // --- Determine source files ---
            let changedSources: string[];

            if (args.files && args.files.length > 0) {
                // Explicit list provided — resolve and filter
                changedSources = args.files
                    .map((f) => (path.isAbsolute(f) ? f : path.resolve(root, f)))
                    .filter((f) => {
                        const ext = path.extname(f);
                        return SOURCE_EXTENSIONS.has(ext) && !isTestFile(f) && fs.existsSync(f);
                    });
            } else {
                // Auto-detect via git diff
                let allChanged: string[];
                try {
                    allChanged = await getChangedFilePaths(root, args.base);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        success: false,
                                        error: `git diff failed: ${msg}`,
                                        hint: "Make sure the directory is a git repository, or provide 'files' explicitly.",
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                        isError: true,
                    };
                }

                changedSources = allChanged.filter((f) => {
                    const ext = path.extname(f);
                    return SOURCE_EXTENSIONS.has(ext) && !isTestFile(f);
                });
            }

            if (changedSources.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    success: true,
                                    message:
                                        "No changed source files detected. " +
                                        "If you expected changes, make sure files are staged or provide 'base' / 'files'.",
                                    filePlans: [],
                                    executionSteps: [],
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            }

            // --- Build file plans ---
            const convention = detectTestConvention(root);
            const { plans, skipped } = buildFilePlans(changedSources, root, convention);

            // --- Build execution steps ---
            const executionSteps = buildExecutionSteps(
                { root, filePlans: plans, testRunner: info.testRunner },
                args.base
            );

            // --- Build confirmation prompt ---
            const projectName = typeof info.projectName === "string" ? info.projectName : null;
            const confirmationPrompt = buildConfirmationPrompt(plans, projectName);

            const workPlan: WorkPlan = {
                root,
                projectName,
                framework: info.framework,
                testRunner: info.testRunner,
                coverageThresholds: info.coverageThresholds as Record<string, number> | null,
                base: args.base ?? "(working tree — staged + unstaged + untracked)",
                totalChangedFiles: changedSources.length,
                filePlans: plans,
                skipped,
                summary:
                    `Found ${plans.filter((p) => p.action === "create_test").length} file(s) needing new tests ` +
                    `and ${plans.filter((p) => p.action === "update_test").length} file(s) with existing tests to update.`,
                executionSteps,
                confirmationPrompt,
            };

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(workPlan, null, 2),
                    },
                ],
            };
        }
    );
}
