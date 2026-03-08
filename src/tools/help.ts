import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Catálogo de tools con su metadata
// ---------------------------------------------------------------------------

const TOOLS = [
    {
        step: 0,
        name: "plan",
        title: "Plan",
        description:
            "Runs read-only analysis (project setup check, git diff, test file detection) " +
            "and returns a structured work plan: which files need new tests, which need updates, " +
            "what the exact execution steps will be, and a confirmation prompt to show the user. " +
            "No files are written until the user approves.",
        requiredArgs: ["rootPath"],
        optionalArgs: [
            "base (branch/commit to diff against, e.g. 'main')",
            "files (explicit list of source files — skips git diff)",
        ],
        when:
            "ALWAYS call this first, before any other tool. " +
            "Present the returned 'confirmationPrompt' to the user verbatim. " +
            "Only proceed with the remaining steps after the user says yes.",
        outputUsedBy: ["get_test_guidelines", "run_coverage", "read_source_files", "write_test_file"],
    },
    {
        step: 1,
        name: "project_info",
        title: "Project Info",
        description: "Inspects the repository to confirm it has git, package.json, and a test runner (jest/vitest) configured. Also detects the framework (next/node), coverage thresholds, and whether the project is ready for test generation.",
        requiredArgs: ["rootPath"],
        optionalArgs: [],
        when: "Called internally by 'plan'. Only call this directly if you need to inspect the project setup without building a full work plan.",
        outputUsedBy: ["get_changed_files", "run_coverage", "get_test_guidelines"],
    },
    {
        step: 2,
        name: "get_changed_files",
        title: "Get Changed Files",
        description: "Lists source files modified in the current working tree or against a base branch. Filters out non-source files and test files by default.",
        requiredArgs: ["rootPath"],
        optionalArgs: ["base (e.g. 'main', 'HEAD~1')", "includeTests"],
        when: "Called internally by 'plan'. Only call this directly for custom git diff queries outside the standard workflow.",
        outputUsedBy: ["run_coverage", "read_source_files"],
    },
    {
        step: 3,
        name: "run_coverage",
        title: "Run Coverage",
        description: "Runs jest/vitest with coverage enabled, scoped only to the source files provided. Returns structured metrics (statements, branches, functions, lines with percentages) and a human-readable summary.",
        requiredArgs: ["rootPath", "files (from plan.filePlans[].sourceFile)"],
        optionalArgs: ["testRunner ('jest' | 'vitest')", "testPathPattern"],
        when: "Run after the user approves the plan, to measure baseline coverage. Run again after all write_test_file calls to confirm improvement.",
        outputUsedBy: ["write_test_file (to identify what needs testing)"],
    },
    {
        step: 4,
        name: "get_test_guidelines",
        title: "Get Test Guidelines",
        description: "Returns framework-specific testing rules and patterns based on the project's detected dependencies (jest/vitest, React, Next.js, Prisma, MSW, etc.). Tailors guidelines to the specific file role (component, hook, API route, service, utility) when focusFile is provided.",
        requiredArgs: ["rootPath"],
        optionalArgs: ["focusFile (path to the source file you are about to test)"],
        when: "Call ONCE per project after the user approves the plan. Provides the rules the model must follow when generating test content.",
        outputUsedBy: ["write_test_file"],
    },
    {
        step: 5,
        name: "read_source_files",
        title: "Read Source Files",
        description: "Reads the content of changed source files AND their corresponding existing test files. For files without tests, auto-detects the project convention (colocated / __tests__) and provides a 'suggestedPath' ready to use in write_test_file. Also includes import analysis with corrected paths.",
        requiredArgs: ["rootPath", "files (from plan.filePlans[].sourceFile)"],
        optionalArgs: ["maxCharsPerFile (default: 8000)"],
        when: "Run after get_test_guidelines. Provides the full source + test context needed to generate or update tests accurately.",
        outputUsedBy: ["get_test_context", "write_test_file"],
    },
    {
        step: 6,
        name: "get_test_context",
        title: "Get Test Context",
        description: "Reads first-level relative imports of the given source files and extracts ONLY exported types, interfaces, enums, constants and function signatures — no implementations. Provides the minimum type context needed to generate correct mocks.",
        requiredArgs: ["rootPath", "files (source files to analyze)"],
        optionalArgs: ["maxDepth (1-3, default: 1)"],
        when: "Use BEFORE write_test_file when the source file has complex type dependencies or many imports. Helps generate correct mock signatures without hallucinating types.",
        outputUsedBy: ["write_test_file"],
    },
    {
        step: 7,
        name: "list_test_files",
        title: "List Test Files",
        description: "Scans the entire repository and builds an inventory: which source files have tests, which don't, and which test files are orphans (their source no longer exists). Returns file-level coverage percentage.",
        requiredArgs: ["rootPath"],
        optionalArgs: ["includeOrphans (default: true)", "includeUntested (default: true)", "maxFiles (default: 500)"],
        when: "Use to get a bird's-eye view of test coverage before deciding which files to focus on. Also used internally by 'plan' for orphan detection.",
        outputUsedBy: ["read_source_files (to prioritize which untested files to tackle)"],
    },
    {
        step: 8,
        name: "write_test_file",
        title: "Write Test File",
        description: "Writes or updates a test file on disk. Runs tsc --noEmit validation before writing (disable with validate=false). SAFETY: only accepts paths matching a test file pattern (.test.ts, .spec.ts, etc.). Directories are created automatically.",
        requiredArgs: ["rootPath", "filePath (use plan.filePlans[].targetTestPath)", "content"],
        optionalArgs: ["overwrite (default: false — set true to update existing)", "validate (default: true — runs tsc before writing)"],
        when: "Run per file ONLY after the user has approved the plan. Use 'plan.filePlans[].targetTestPath' as the filePath.",
        outputUsedBy: ["run_coverage (re-run to verify improvement)"],
    },
] as const;

const WORKFLOW = [
    "0. plan               → analyze project, detect changed files, build work plan, ask user to confirm",
    "--- user approves ---",
    "1. get_test_guidelines → get framework-specific testing rules (once per project)",
    "2. run_coverage        → measure baseline coverage for changed files",
    "3. read_source_files   → read source + existing tests + import analysis",
    "4. get_test_context    → extract type dependencies (optional, for complex files)",
    "5. write_test_file     → generate/update test files (repeat per file in the plan)",
    "6. run_coverage        → re-run to confirm coverage improved",
];

const SAFETY_RULES = [
    "ALWAYS call 'plan' first and present the confirmation prompt to the user before writing anything.",
    "write_test_file NEVER writes to source files — only .test.* / .spec.* paths are accepted.",
    "All tools require 'rootPath' explicitly — no silent fallback to process.cwd().",
    "write_test_file requires overwrite=true to update an existing test file.",
    "write_test_file runs tsc --noEmit before writing (set validate=false to skip).",
    "Directories for new test files are created automatically — do not ask the user to create them.",
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const HelpSchema = z.object({
    tool: z
        .string()
        .optional()
        .describe(
            "Name of a specific tool to get detailed help for (e.g. 'run_coverage'). " +
            "If omitted, returns the full workflow overview with all tools."
        ),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHelp(server: McpServer) {
    server.registerTool(
        "help",
        {
            title: "Help — MCP Tests",
            description:
                "Shows what this MCP can do, the recommended step-by-step workflow, " +
                "and detailed info about each tool (required args, when to use it, " +
                "what its output feeds into). Call this first if you are unsure where to start.",
            inputSchema: HelpSchema,
        },
        async (args) => {
            if (args.tool) {
                // Ayuda específica de un tool
                const found = TOOLS.find((t) => t.name === args.tool);
                if (!found) {
                    const names = TOOLS.map((t) => t.name).join(", ");
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        error: `Tool '${args.tool}' not found.`,
                                        availableTools: names,
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                        isError: true,
                    };
                }

                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(found, null, 2),
                        },
                    ],
                };
            }

            // Overview completo
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                mcp: "mcp-tests",
                                purpose:
                                    "Automates test generation and coverage improvement for TypeScript/JavaScript projects using jest or vitest. " +
                                    "Detects changed files, measures coverage, reads source context, and writes test files — " +
                                    "without ever modifying source files.",
                                recommendedWorkflow: WORKFLOW,
                                safetyRules: SAFETY_RULES,
                                tools: TOOLS.map((t) => ({
                                    step: t.step,
                                    name: t.name,
                                    title: t.title,
                                    when: t.when,
                                    requiredArgs: t.requiredArgs,
                                    optionalArgs: t.optionalArgs,
                                })),
                                tip: "Call help({ tool: '<name>' }) for full details on any specific tool.",
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );
}
