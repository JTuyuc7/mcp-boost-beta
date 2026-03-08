import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import {
    resolveRootPath,
    rootPathErrorResponse,
    findTestFileForSource,
    suggestTestFilePath,
    detectTestConvention,
    isTestFile,
    type TestConvention,
} from "../helpers/repo.js";
import { analyzeImports, type ImportsAnalysis } from "../helpers/imports.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ReadSourceFilesSchema = z.object({
    rootPath: z
        .string()
        .min(1)
        .describe("Absolute path to the repository root (workspace folder)."),
    files: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "List of absolute paths to source files to read. " +
            "Use the 'sourceFiles' output of 'get_changed_files'."
        ),
    maxCharsPerFile: z
        .number()
        .int()
        .positive()
        .optional()
        .default(8000)
        .describe(
            "Maximum characters to read per file to avoid exceeding context limits. " +
            "Defaults to 8000 chars (~200 lines)."
        ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestFileInfo {
    /** Ruta absoluta del test file existente, o null si no existe aún */
    path: string | null;
    relativePath: string | null;
    exists: boolean;
    content: string | null;
    truncated: boolean;
    /**
     * Ruta absoluta sugerida donde DEBERÍA crearse el test file si no existe.
     * Calculada respetando la convención detectada en el proyecto
     * (colocated, __tests__ hermano, o __tests__ en la raíz).
     * Úsala directamente como `filePath` en `write_test_file`.
     */
    suggestedPath: string;
    suggestedRelativePath: string;
}

interface FileContent {
    path: string;
    relativePath: string;
    exists: boolean;
    content: string | null;
    truncated: boolean;
    testFile: TestFileInfo;
    /**
     * Análisis de imports del archivo fuente reescritos para usarse
     * desde la ubicación del test file. Incluye `suggestedImportBlock`
     * listo para pegar al inicio del test file generado.
     */
    importsAnalysis: ImportsAnalysis;
}

async function readFileSafe(
    filePath: string,
    maxChars: number
): Promise<{ content: string | null; truncated: boolean; exists: boolean }> {
    if (!fs.existsSync(filePath)) {
        return { content: null, truncated: false, exists: false };
    }
    try {
        const raw = await fsPromises.readFile(filePath, "utf-8");
        if (raw.length > maxChars) {
            return {
                content: raw.slice(0, maxChars) + "\n\n// [truncated — file exceeds maxCharsPerFile]",
                truncated: true,
                exists: true,
            };
        }
        return { content: raw, truncated: false, exists: true };
    } catch {
        return { content: null, truncated: false, exists: false };
    }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReadSourceFiles(server: McpServer) {
    server.registerTool(
        "read_source_files",
        {
            title: "Read Source Files",
            description:
                "Step 4 — Reads the content of the changed source files AND their " +
                "corresponding existing test files (if any). " +
                "For files WITHOUT tests, automatically detects the project's test " +
                "convention (colocated / __tests__ folder) and provides a " +
                "'suggestedPath' ready to use as the 'filePath' argument in " +
                "'write_test_file' — no need to ask the user where to put the file. " +
                "Directories are created automatically by 'write_test_file'.",
            inputSchema: ReadSourceFilesSchema,
        },
        async (args) => {
            console.error("[read_source_files] reading", args.files.length, "files");

            const resolved = resolveRootPath(args.rootPath);
            if (!resolved.ok) return rootPathErrorResponse(resolved);

            const root = resolved.root;
            const maxChars = args.maxCharsPerFile ?? 8000;

            // Detectar la convención del proyecto UNA vez, no por archivo
            const convention: TestConvention = detectTestConvention(root);
            console.error("[read_source_files] detected convention:", convention);

            // Paralelizar la lectura de archivos para mejorar performance (2-3x más rápido)
            const sourceFiles = args.files.filter((f) => !isTestFile(f));

            const results: FileContent[] = await Promise.all(
                sourceFiles.map(async (filePath) => {
                    const source = await readFileSafe(filePath, maxChars);
                    const existingTestPath = findTestFileForSource(filePath, root);
                    const suggested = suggestTestFilePath(filePath, root, convention);
                    const resolvedTestPath = existingTestPath ?? suggested;

                    const testFileRead = existingTestPath
                        ? await readFileSafe(existingTestPath, maxChars)
                        : { content: null, truncated: false, exists: false };

                    // Analiza imports del fuente reescritos para el test file
                    const importsAnalysis = analyzeImports(filePath, resolvedTestPath, root);

                    return {
                        path: filePath,
                        relativePath: path.relative(root, filePath),
                        exists: source.exists,
                        content: source.content,
                        truncated: source.truncated,
                        importsAnalysis,
                        testFile: {
                            path: existingTestPath,
                            relativePath: existingTestPath
                                ? path.relative(root, existingTestPath)
                                : null,
                            exists: testFileRead.exists,
                            content: testFileRead.content,
                            truncated: testFileRead.truncated,
                            suggestedPath: resolvedTestPath,
                            suggestedRelativePath: path.relative(root, resolvedTestPath),
                        },
                    };
                })
            );

            const withTests = results.filter((r) => r.testFile.exists).length;
            const withoutTests = results.filter((r) => !r.testFile.exists).length;
            const filesWithoutTests = results
                .filter((r) => !r.testFile.exists)
                .map((r) => ({
                    sourceFile: r.relativePath,
                    createTestAt: r.testFile.suggestedRelativePath,
                }));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                root,
                                testConvention: convention,
                                totalFiles: results.length,
                                filesWithExistingTests: withTests,
                                filesWithoutTests: withoutTests,
                                // Resumen accionable para que el modelo sepa exactamente qué hacer
                                actionRequired:
                                    withoutTests > 0
                                        ? {
                                              message: `${withoutTests} file(s) have no tests. ` +
                                                  `Use 'write_test_file' with the 'suggestedPath' for each. ` +
                                                  `Directories will be created automatically — do NOT ask the user to create them.`,
                                              filesToCreate: filesWithoutTests,
                                          }
                                        : {
                                              message: `All files have existing tests. ` +
                                                  `Review coverage gaps from 'run_coverage' and update with 'write_test_file' + overwrite=true.`,
                                              filesToCreate: [],
                                          },
                                files: results,
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
