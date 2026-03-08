import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { resolveRootPath, rootPathErrorResponse, readPackageJson } from "../helpers/repo.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ProjectInfoSchema = z.object({
    rootPath: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Absolute path to the repository root (workspace folder). " +
            "Always pass this so the server inspects the correct project."
        ),
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

type Framework = "next" | "node" | "unknown";
type TestRunner = "jest" | "vitest" | "unknown";

function detectFramework(pkg: Record<string, unknown>): Framework {
    const deps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    if ("next" in deps) return "next";
    return "node";
}

function detectTestRunner(
    pkg: Record<string, unknown>,
    root: string
): TestRunner {
    const deps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };

    if ("vitest" in deps) return "vitest";
    if ("jest" in deps) return "jest";

    // fallback: buscar archivos de config
    const jestConfigs = ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"];
    const vitestConfigs = ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"];

    if (jestConfigs.some((f) => fs.existsSync(path.join(root, f)))) return "jest";
    if (vitestConfigs.some((f) => fs.existsSync(path.join(root, f)))) return "vitest";

    return "unknown";
}

function getTestScript(pkg: Record<string, unknown>): string | null {
    const scripts = (pkg.scripts as Record<string, string>) ?? {};
    return scripts.test ?? scripts["test:coverage"] ?? null;
}

// ---------------------------------------------------------------------------
// Coverage thresholds
// ---------------------------------------------------------------------------

interface CoverageThresholds {
    statements?: number;
    branches?: number;
    functions?: number;
    lines?: number;
}

/**
 * Intenta leer los umbrales de coverage configurados en jest.config o vitest.config.
 * Devuelve null si no se encuentran o no se pueden parsear.
 */
function readCoverageThresholds(root: string): CoverageThresholds | null {
    // --- jest.config.* ---
    const jestConfigs = [
        "jest.config.ts", "jest.config.js",
        "jest.config.mjs", "jest.config.cjs",
    ];

    for (const configFile of jestConfigs) {
        const fullPath = path.join(root, configFile);
        if (!fs.existsSync(fullPath)) continue;
        try {
            const content = fs.readFileSync(fullPath, "utf-8");
            // Busca coverageThreshold: { global: { ... } }
            const match = content.match(/coverageThreshold\s*:\s*\{[^}]*global\s*:\s*(\{[^}]*\})/s);
            if (match?.[1]) {
                const thresholds = parseThresholdObject(match[1]);
                if (thresholds) return thresholds;
            }
        } catch { /* ignorar */ }
    }

    // --- vitest.config.* ---
    const vitestConfigs = [
        "vitest.config.ts", "vitest.config.js", "vitest.config.mjs",
    ];

    for (const configFile of vitestConfigs) {
        const fullPath = path.join(root, configFile);
        if (!fs.existsSync(fullPath)) continue;
        try {
            const content = fs.readFileSync(fullPath, "utf-8");
            // Busca thresholds: { ... } dentro del bloque coverage
            const match = content.match(/thresholds\s*:\s*(\{[^}]*\})/s);
            if (match?.[1]) {
                const thresholds = parseThresholdObject(match[1]);
                if (thresholds) return thresholds;
            }
        } catch { /* ignorar */ }
    }

    return null;
}

/** Parsea un objeto literal simple de umbrales desde texto */
function parseThresholdObject(raw: string): CoverageThresholds | null {
    const result: CoverageThresholds = {};
    const re = /(statements|branches|functions|lines)\s*:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    let found = false;

    while ((m = re.exec(raw)) !== null) {
        const key = m[1] as keyof CoverageThresholds;
        const val = parseFloat(m[2] ?? "0");
        if (!isNaN(val)) {
            result[key] = val;
            found = true;
        }
    }

    return found ? result : null;
}

export function projectInfoAt(root: string) {
    const hasGit = fs.existsSync(path.join(root, ".git"));
    const pkg = readPackageJson(root);
    const hasPackageJson = pkg !== null;

    const testRunner = pkg ? detectTestRunner(pkg, root) : ("unknown" as TestRunner);
    const framework = pkg ? detectFramework(pkg) : ("unknown" as Framework);
    const testScript = pkg ? getTestScript(pkg) : null;

    // Configs de jest/vitest presentes
    const jestConfigs = ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"];
    const vitestConfigs = ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"];
    const foundJestConfig = jestConfigs.find((f) => fs.existsSync(path.join(root, f)));
    const foundVitestConfig = vitestConfigs.find((f) => fs.existsSync(path.join(root, f)));

    const ready = hasGit && hasPackageJson && testRunner !== "unknown";
    const coverageThresholds = readCoverageThresholds(root);

    return {
        root,
        projectName: pkg?.name ?? null,
        framework,
        testRunner,
        testScript,
        hasGit,
        hasPackageJson,
        configFiles: {
            jest: foundJestConfig ?? null,
            vitest: foundVitestConfig ?? null,
        },
        /**
         * Umbrales de coverage configurados en jest.config / vitest.config.
         * null = no configurados (el proyecto no tiene requisito de coverage).
         * Usa estos valores para saber si el coverage generado "pasa" o no.
         */
        coverageThresholds,
        ready,
        message: ready
            ? `Project is ready. Use 'get_changed_files' to detect what changed.`
            : `Project is missing: ${[
                  !hasGit && "git repository",
                  !hasPackageJson && "package.json",
                  testRunner === "unknown" && "jest/vitest dependency or config",
              ]
                  .filter(Boolean)
                  .join(", ")}.`,
    };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectInfo(server: McpServer) {
    server.registerTool(
        "project_info",
        {
            title: "Project Info",
            description:
                "Step 1 — Inspect the repository to confirm it has git, a package.json, " +
                "and a test runner (jest/vitest) configured. Returns framework (next/node), " +
                "test runner, config files found, and whether the project is ready for test generation. " +
                "Always run this first before using any other tool.",
            inputSchema: ProjectInfoSchema,
        },
        async (args) => {
            console.error("[project_info] args:", JSON.stringify(args));

            const resolved = resolveRootPath(args.rootPath);
            if (!resolved.ok) return rootPathErrorResponse(resolved);

            const root = resolved.root;
            console.error("[project_info] resolved root:", root);

            const result = projectInfoAt(root);

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
    );
}
