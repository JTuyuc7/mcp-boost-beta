/**
 * Tool: list_test_files
 *
 * Inventario de todos los test files del proyecto.
 * Para cada test file indica su archivo fuente correspondiente (si existe)
 * y detecta tests huérfanos (cuyo archivo fuente ya no existe).
 * También lista archivos fuente que NO tienen test file.
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
    resolveRootPath,
    rootPathErrorResponse,
    SOURCE_EXTENSIONS,
    isTestFile,
    findTestFileForSource,
    walkDir,
} from "../helpers/repo.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ListTestFilesSchema = {
    rootPath: z
        .string()
        .describe(
            "Absolute path to the repository root. Must be provided explicitly — " +
            "never infer it from cwd."
        ),
    includeOrphans: z
        .boolean()
        .optional()
        .default(true)
        .describe(
            "If true (default), includes test files whose source file no longer exists. " +
            "Orphans may be safe to delete."
        ),
    includeUntested: z
        .boolean()
        .optional()
        .default(true)
        .describe(
            "If true (default), includes source files that have no corresponding test file."
        ),
    maxFiles: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(500)
        .describe("Maximum number of files to scan (default: 500)."),
};

// ---------------------------------------------------------------------------
// File scanning helpers
// ---------------------------------------------------------------------------

/**
 * Dado un test file path, intenta encontrar el archivo fuente correspondiente.
 * Estrategia: elimina los sufijos de test (.test, .spec) y busca el archivo.
 */
function findSourceForTest(testFile: string, root: string): string | null {
    const dir = path.dirname(testFile);
    const base = path.basename(testFile);

    // Eliminar sufijo de test: .test.ts → .ts, .spec.tsx → .tsx, etc.
    const withoutTestSuffix = base.replace(/\.(test|spec)(\.[^.]+)$/, "$2");
    if (withoutTestSuffix === base) {
        // No tiene sufijo reconocible — puede ser __tests__/foo.ts → ../foo.ts
        // intentar subir un nivel
        const parentDir = path.dirname(dir);
        const dirName = path.basename(dir);
        if (dirName === "__tests__") {
            for (const ext of SOURCE_EXTENSIONS) {
                const candidate = path.join(parentDir, base.replace(/\.[^.]+$/, ext));
                if (fs.existsSync(candidate) && !isTestFile(candidate)) {
                    return candidate;
                }
            }
        }
        return null;
    }

    // Probar en el mismo directorio
    for (const ext of SOURCE_EXTENSIONS) {
        const candidate = path.join(dir, withoutTestSuffix.replace(/\.[^.]+$/, ext));
        if (fs.existsSync(candidate) && !isTestFile(candidate)) {
            return candidate;
        }
    }

    // Probar subiendo un nivel (colocated tests en subdirectorios)
    const parentDir = path.dirname(dir);
    for (const ext of SOURCE_EXTENSIONS) {
        const candidate = path.join(parentDir, withoutTestSuffix.replace(/\.[^.]+$/, ext));
        if (fs.existsSync(candidate) && !isTestFile(candidate)) {
            return candidate;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

interface TestFileEntry {
    testFile: string;
    relTestFile: string;
    sourceFile: string | null;
    relSourceFile: string | null;
    isOrphan: boolean;
}

interface SourceFileEntry {
    sourceFile: string;
    relSourceFile: string;
    testFile: string | null;
    relTestFile: string | null;
    hasTest: boolean;
}

interface Inventory {
    testFiles: TestFileEntry[];
    sourceFiles: SourceFileEntry[];
    summary: {
        totalTestFiles: number;
        totalSourceFiles: number;
        orphanTests: number;
        untestedSources: number;
        testedSources: number;
        coveragePercent: number;
    };
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

function buildInventory(
    root: string,
    includeOrphans: boolean,
    includeUntested: boolean,
    maxFiles: number
): Inventory {
    const allTestFiles: string[] = [];
    const allSourceFiles: string[] = [];

    for (const file of walkDir(root, maxFiles * 2)) {
        const ext = path.extname(file);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        if (isTestFile(file)) {
            allTestFiles.push(file);
        } else {
            allSourceFiles.push(file);
        }
    }

    // Build test file entries
    const testEntries: TestFileEntry[] = allTestFiles.map((tf) => {
        const sourceFile = findSourceForTest(tf, root);
        const isOrphan = sourceFile === null;
        return {
            testFile: tf,
            relTestFile: path.relative(root, tf),
            sourceFile,
            relSourceFile: sourceFile ? path.relative(root, sourceFile) : null,
            isOrphan,
        };
    });

    // Build source file entries
    const testedSourcePaths = new Set(
        testEntries
            .filter((e) => e.sourceFile !== null)
            .map((e) => e.sourceFile!)
    );

    const sourceEntries: SourceFileEntry[] = allSourceFiles.map((sf) => {
        // First check if any test entry already maps to this source
        const existingEntry = testEntries.find((e) => e.sourceFile === sf);
        if (existingEntry) {
            return {
                sourceFile: sf,
                relSourceFile: path.relative(root, sf),
                testFile: existingEntry.testFile,
                relTestFile: existingEntry.relTestFile,
                hasTest: true,
            };
        }

        // Try to find via findTestFileForSource
        const found = findTestFileForSource(sf, root);
        return {
            sourceFile: sf,
            relSourceFile: path.relative(root, sf),
            testFile: found ?? null,
            relTestFile: found ? path.relative(root, found) : null,
            hasTest: found !== null,
        };
    });

    const orphanCount = testEntries.filter((e) => e.isOrphan).length;
    const untestedCount = sourceEntries.filter((e) => !e.hasTest).length;
    const testedCount = sourceEntries.filter((e) => e.hasTest).length;
    const totalSource = sourceEntries.length;
    const coveragePct =
        totalSource > 0 ? Math.round((testedCount / totalSource) * 100) : 0;

    return {
        testFiles: includeOrphans ? testEntries : testEntries.filter((e) => !e.isOrphan),
        sourceFiles: includeUntested ? sourceEntries : sourceEntries.filter((e) => e.hasTest),
        summary: {
            totalTestFiles: allTestFiles.length,
            totalSourceFiles: allSourceFiles.length,
            orphanTests: orphanCount,
            untestedSources: untestedCount,
            testedSources: testedCount,
            coveragePercent: coveragePct,
        },
    };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerListTestFiles(server: McpServer): void {
    server.registerTool(
        "list_test_files",
        {
            description:
                "Scans the repository and builds an inventory of all test files and source files. " +
                "For each test file it finds the corresponding source file (or marks it as orphan). " +
                "For each source file it shows whether a test file exists. " +
                "Use this to: (1) identify which files need tests, (2) find orphan test files " +
                "that can be deleted, (3) get an overview of test coverage at the file level.",
            inputSchema: ListTestFilesSchema,
        },
        async (args) => {
            const rootResult = resolveRootPath(args.rootPath);
            if (!rootResult.ok) return rootPathErrorResponse(rootResult);
            const root = rootResult.root;

            const inventory = buildInventory(
                root,
                args.includeOrphans,
                args.includeUntested,
                args.maxFiles
            );

            // Build human-readable summary
            const { summary } = inventory;
            const lines: string[] = [
                `📦 Test Inventory for ${root}`,
                ``,
                `  Test files:     ${summary.totalTestFiles}`,
                `  Source files:   ${summary.totalSourceFiles}`,
                `  Tested:         ${summary.testedSources} / ${summary.totalSourceFiles} (${summary.coveragePercent}%)`,
                `  Untested:       ${summary.untestedSources}`,
                `  Orphan tests:   ${summary.orphanTests}`,
            ];

            if (args.includeOrphans && summary.orphanTests > 0) {
                lines.push(``, `🔴 Orphan test files (source not found):`);
                inventory.testFiles
                    .filter((e) => e.isOrphan)
                    .forEach((e) => lines.push(`  - ${e.relTestFile}`));
            }

            if (args.includeUntested && summary.untestedSources > 0) {
                lines.push(``, `⚪ Source files without tests:`);
                inventory.sourceFiles
                    .filter((e) => !e.hasTest)
                    .slice(0, 50) // cap display to 50
                    .forEach((e) => lines.push(`  - ${e.relSourceFile}`));
                if (summary.untestedSources > 50) {
                    lines.push(`  ... and ${summary.untestedSources - 50} more`);
                }
            }

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                summary: inventory.summary,
                                testFiles: inventory.testFiles.map((e) => ({
                                    testFile: e.relTestFile,
                                    sourceFile: e.relSourceFile,
                                    isOrphan: e.isOrphan,
                                })),
                                sourceFiles: inventory.sourceFiles.map((e) => ({
                                    sourceFile: e.relSourceFile,
                                    testFile: e.relTestFile,
                                    hasTest: e.hasTest,
                                })),
                                humanReadable: lines.join("\n"),
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
