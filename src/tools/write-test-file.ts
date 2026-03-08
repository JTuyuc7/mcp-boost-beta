import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { isTestFile, SOURCE_EXTENSIONS, resolveRootPath, rootPathErrorResponse } from "../helpers/repo.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const WriteTestFileSchema = z.object({
    rootPath: z
        .string()
        .min(1)
        .describe("Absolute path to the repository root (workspace folder)."),
    filePath: z
        .string()
        .min(1)
        .describe(
            "Absolute path where the test file should be written. " +
            "MUST end in .test.ts, .test.tsx, .spec.ts, .spec.tsx, .test.js, .test.jsx, " +
            ".spec.js, or .spec.jsx. Files NOT matching a test pattern are rejected."
        ),
    content: z
        .string()
        .min(1)
        .describe("Full content of the test file to write."),
    overwrite: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            "If false (default), the tool will fail if the file already exists " +
            "to prevent accidental overwrites. Set to true to update an existing test file."
        ),
    validate: z
        .boolean()
        .optional()
        .default(true)
        .describe(
            "If true (default), runs tsc --noEmit on the generated content before writing " +
            "to catch TypeScript errors early. Set to false to skip validation " +
            "(e.g. for .js projects or when tsconfig is not present)."
        ),
});

// ---------------------------------------------------------------------------
// TypeScript validation
// ---------------------------------------------------------------------------

interface ValidationResult {
    passed: boolean;
    errors: string[];
}

/**
 * Valida el contenido del test file escribiéndolo en un archivo temporal
 * y corriendo `tsc --noEmit` sobre él. El archivo temporal se elimina siempre.
 *
 * Estrategia: escribe el archivo en su destino final pero lo borra si falla.
 * Así tsc puede resolver imports relativos correctamente con el tsconfig del proyecto.
 * Usa execFileAsync para no bloquear el event loop durante la validación.
 */
async function validateWithTsc(
    content: string,
    targetPath: string,
    root: string
): Promise<ValidationResult> {
    const hasTsConfig =
        fs.existsSync(path.join(root, "tsconfig.json")) ||
        fs.existsSync(path.join(root, "tsconfig.base.json"));

    if (!hasTsConfig) {
        return { passed: true, errors: [] }; // sin tsconfig, no podemos validar
    }

    // Determinar si el archivo es TypeScript
    const ext = path.extname(targetPath);
    if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
        return { passed: true, errors: [] }; // no validar JS
    }

    const tmpPath = targetPath + `.__mcp_${randomBytes(4).toString("hex")}__.ts`;
    try {
        const dir = path.dirname(tmpPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmpPath, content, "utf-8");

        await execFileAsync("npx", ["tsc", "--noEmit", "--skipLibCheck", tmpPath], {
            cwd: root,
            encoding: "utf-8",
            timeout: 30_000,
        });

        return { passed: true, errors: [] };
    } catch (err: unknown) {
        const execError = err as { stdout?: string; stderr?: string };
        const output = ((execError.stdout ?? "") + "\n" + (execError.stderr ?? "")).trim();

        // Filtrar líneas del archivo temporal y limpiar el path temporal del mensaje
        const lines = output
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => l.replace(tmpPath, targetPath))
            .slice(0, 30); // máximo 30 líneas de errores

        return { passed: false, errors: lines };
    } finally {
        try { fs.unlinkSync(tmpPath); } catch { /* ya fue borrado */ }
    }
}

// ---------------------------------------------------------------------------
// Safety guards
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERNS = [
    /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
    /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
];

/** Returns true only if the path looks like a test file */
function isValidTestPath(filePath: string): boolean {
    return TEST_FILE_PATTERNS.some((re) => re.test(filePath));
}

/**
 * Ensures the file is inside the project root to prevent path traversal.
 */
function isInsideRoot(filePath: string, root: string): boolean {
    const resolved = path.resolve(filePath);
    const resolvedRoot = path.resolve(root);
    return resolved.startsWith(resolvedRoot + path.sep) || resolved === resolvedRoot;
}

/**
 * Refuses to write if the path doesn't look like a test file
 * or if it's not inside the project root.
 */
function validateTestFilePath(
    filePath: string,
    root: string
): { valid: true } | { valid: false; reason: string } {
    if (!isValidTestPath(filePath)) {
        return {
            valid: false,
            reason:
                `Rejected: '${path.basename(filePath)}' does not match a test file pattern. ` +
                `File must end in .test.ts / .spec.ts / .test.js / .spec.js (or tsx/jsx variants).`,
        };
    }

    if (!isInsideRoot(filePath, root)) {
        return {
            valid: false,
            reason: `Rejected: '${filePath}' is outside the project root '${root}'.`,
        };
    }

    // Extra safety: reject if the path points to a known source file that is NOT a test
    const ext = path.extname(filePath);
    if (SOURCE_EXTENSIONS.has(ext) && !isTestFile(filePath)) {
        return {
            valid: false,
            reason: `Rejected: '${filePath}' appears to be a source file, not a test file.`,
        };
    }

    return { valid: true };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWriteTestFile(server: McpServer) {
    server.registerTool(
        "write_test_file",
        {
            title: "Write Test File",
            description:
                "Step 5 — Writes or updates a test file on disk. " +
                "SAFETY: Only accepts paths that match a test file pattern " +
                "(.test.ts, .spec.ts, etc.). Will NEVER overwrite source files. " +
                "Creates parent directories automatically. " +
                "Set overwrite=true to update an existing test file.",
            inputSchema: WriteTestFileSchema,
        },
        async (args) => {
            console.error("[write_test_file] writing:", args.filePath);

            const resolved = resolveRootPath(args.rootPath);
            if (!resolved.ok) return rootPathErrorResponse(resolved);

            const root = resolved.root;

            // --- Safety validation ---
            const validation = validateTestFilePath(args.filePath, root);
            if (!validation.valid) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ success: false, error: validation.reason }, null, 2),
                        },
                    ],
                    isError: true,
                };
            }

            const resolvedPath = path.resolve(args.filePath);
            const alreadyExists = fs.existsSync(resolvedPath);

            if (alreadyExists && !args.overwrite) {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(
                                {
                                    success: false,
                                    error:
                                        `File '${resolvedPath}' already exists. ` +
                                        `Set overwrite=true to update it.`,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                    isError: true,
                };
            }

            // --- TypeScript validation (before writing) ---
            if (args.validate !== false) {
                const validation = await validateWithTsc(args.content, resolvedPath, root);
                if (!validation.passed) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify(
                                    {
                                        success: false,
                                        error: "TypeScript validation failed. Fix the errors and retry.",
                                        tscErrors: validation.errors,
                                        hint: "Correct the generated test content using the errors above, then call write_test_file again.",
                                        validatedPath: resolvedPath,
                                    },
                                    null,
                                    2
                                ),
                            },
                        ],
                        isError: true,
                    };
                }
            }

            // --- Write file ---
            const dir = path.dirname(resolvedPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolvedPath, args.content, "utf-8");

            const action = alreadyExists ? "updated" : "created";
            console.error(`[write_test_file] ${action}:`, resolvedPath);

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                success: true,
                                action,
                                filePath: resolvedPath,
                                relativePath: path.relative(root, resolvedPath),
                                lines: args.content.split("\n").length,
                                nextStep:
                                    `File ${action}. Run 'run_coverage' again to verify ` +
                                    `coverage improved for the targeted source files.`,
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
