/**
 * Tool: get_test_context
 *
 * Lee las dependencias de primer nivel de cada archivo fuente y extrae solo
 * los tipos, interfaces, enums y constantes exportadas — el contexto mínimo
 * que el modelo necesita para generar mocks e imports correctos.
 *
 * NO lee implementaciones completas, solo firmas y tipos.
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRootPath, rootPathErrorResponse } from "../helpers/repo.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetTestContextSchema = {
    rootPath: z
        .string()
        .describe(
            "Absolute path to the repository root. Must be provided explicitly — " +
            "never infer it from cwd."
        ),
    files: z
        .array(z.string())
        .min(1)
        .describe(
            "List of absolute or rootPath-relative paths to the source files " +
            "you are about to test. The tool will read their first-level relative " +
            "imports and extract exported types/interfaces/enums/constants."
        ),
    maxDepth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .default(1)
        .describe(
            "How many levels of relative imports to follow (default: 1). " +
            "Increase to 2-3 only if the type dependencies are deep."
        ),
};


// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Patterns que identifican declaraciones exportadas de tipos / firmas.
 * Captura solo líneas declarativas, no implementaciones.
 */
const EXPORT_PATTERNS: RegExp[] = [
    /^export\s+(type\s+)?interface\s+\w+/,
    /^export\s+(type\s+)?type\s+\w+/,
    /^export\s+(declare\s+)?enum\s+\w+/,
    /^export\s+const\s+\w+\s*[:=]/,
    /^export\s+function\s+\w+\s*[<(]/,
    /^export\s+(abstract\s+)?class\s+\w+/,
    /^export\s+default\s+/,
];

/** Regex para detectar imports relativos */
const RELATIVE_IMPORT_RE =
    /^\s*import\s+(?:type\s+)?(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"]/gm;

/** Extensiones a intentar cuando un import no tiene extensión */
const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/**
 * Resuelve un import relativo a una ruta absoluta en disco.
 * Retorna null si no se puede encontrar el archivo.
 */
function resolveRelativeImport(
    importPath: string,
    fromFile: string,
    root: string
): string | null {
    const dir = path.dirname(fromFile);
    const base = path.resolve(dir, importPath);

    // Si ya tiene extensión reconocida, prueba directo
    const knownExts = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"];
    if (knownExts.includes(path.extname(base))) {
        return fs.existsSync(base) ? base : null;
    }

    for (const ext of RESOLVE_EXTS) {
        const candidate = base + ext;
        if (fs.existsSync(candidate)) {
            // Asegurarse de que está dentro del repo
            if (candidate.startsWith(root)) return candidate;
        }
    }
    return null;
}

interface ExtractedDeclaration {
    kind: "interface" | "type" | "enum" | "const" | "function" | "class" | "default" | "other";
    name: string;
    lines: string[];
}

/**
 * Extrae bloques de declaraciones exportadas de un archivo TypeScript/JavaScript.
 * Estrategia: detecta la línea de inicio de cada declaración y recoge hasta
 * que el contador de llaves llegue a 0 (o la línea siguiente sea otra declaración).
 */
function extractExportedDeclarations(content: string): ExtractedDeclaration[] {
    const rawLines = content.split("\n");
    const declarations: ExtractedDeclaration[] = [];

    let i = 0;
    while (i < rawLines.length) {
        const line = rawLines[i]!;

        const isExport = EXPORT_PATTERNS.some((p) => p.test(line.trim()));
        if (!isExport) {
            i++;
            continue;
        }

        // Determinar kind y name
        const kind = detectKind(line);
        const name = detectName(line);

        // Recoger el bloque hasta que las llaves se cierren
        const block: string[] = [];
        let depth = 0;
        let j = i;

        while (j < rawLines.length) {
            const l = rawLines[j]!;
            block.push(l);

            // Para líneas de tipo simple (sin llaves ni paréntesis abiertos) terminamos en la primera línea
            const opens = (l.match(/[{(]/g) ?? []).length;
            const closes = (l.match(/[})]/g) ?? []).length;
            depth += opens - closes;

            // Si nunca se abrió nada, terminar al primer punto y coma o final de línea
            if (depth <= 0 && j > i) break;
            if (depth === 0 && j === i && !l.includes("{") && !l.includes("(")) break;

            j++;
        }

        // Limitar a 40 líneas por declaración para no saturar el contexto
        declarations.push({
            kind,
            name,
            lines: block.slice(0, 40),
        });

        i = j + 1;
    }

    return declarations;
}

function detectKind(line: string): ExtractedDeclaration["kind"] {
    const t = line.trim();
    if (t.includes("interface")) return "interface";
    if (t.includes("enum")) return "enum";
    if (/\bconst\b/.test(t)) return "const";
    if (/\bfunction\b/.test(t)) return "function";
    if (/\bclass\b/.test(t)) return "class";
    if (t.startsWith("export type")) return "type";
    if (t.startsWith("export default")) return "default";
    return "other";
}

function detectName(line: string): string {
    const m = line.match(
        /\b(?:interface|type|enum|const|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    );
    return m?.[1] ?? "(anonymous)";
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

interface FileContext {
    file: string;
    relativePath: string;
    /** Imports relativos de primer (o N-ésimo) nivel encontrados */
    firstLevelImports: string[];
    /** Declaraciones exportadas del propio archivo */
    ownExports: ExtractedDeclaration[];
    /** Declaraciones exportadas de los imports analizados */
    dependencyExports: Record<string, ExtractedDeclaration[]>;
    /** Advertencias (archivo no encontrado, etc.) */
    warnings: string[];
}

function analyzeFileContext(
    sourceFile: string,
    root: string,
    maxDepth: number
): FileContext {
    const warnings: string[] = [];
    const resolved = path.isAbsolute(sourceFile)
        ? sourceFile
        : path.resolve(root, sourceFile);

    if (!fs.existsSync(resolved)) {
        return {
            file: resolved,
            relativePath: path.relative(root, resolved),
            firstLevelImports: [],
            ownExports: [],
            dependencyExports: {},
            warnings: [`File not found: ${resolved}`],
        };
    }

    const content = fs.readFileSync(resolved, "utf-8");

    // Extraer declaraciones del propio archivo
    const ownExports = extractExportedDeclarations(content);

    // Encontrar imports relativos (primer nivel)
    const firstLevelImports: string[] = [];
    const dependencyExports: Record<string, ExtractedDeclaration[]> = {};

    // BFS hasta maxDepth
    const toVisit: Array<{ file: string; depth: number }> = [
        { file: resolved, depth: 0 },
    ];
    const visited = new Set<string>([resolved]);

    while (toVisit.length > 0) {
        const current = toVisit.shift()!;
        if (current.depth >= maxDepth) continue;

        const c = fs.readFileSync(current.file, "utf-8");
        let match: RegExpExecArray | null;

        // Reset lastIndex para cada nueva búsqueda
        RELATIVE_IMPORT_RE.lastIndex = 0;

        while ((match = RELATIVE_IMPORT_RE.exec(c)) !== null) {
            const importStr = match[1];
            if (!importStr) continue;

            const depResolved = resolveRelativeImport(importStr, current.file, root);
            if (!depResolved) {
                if (current.depth === 0) {
                    warnings.push(`Could not resolve import '${importStr}' in ${path.relative(root, current.file)}`);
                }
                continue;
            }

            const relDep = path.relative(root, depResolved);

            if (current.depth === 0) {
                firstLevelImports.push(relDep);
            }

            if (!visited.has(depResolved)) {
                visited.add(depResolved);

                try {
                    const depContent = fs.readFileSync(depResolved, "utf-8");
                    const depExports = extractExportedDeclarations(depContent);
                    if (depExports.length > 0) {
                        dependencyExports[relDep] = depExports;
                    }
                } catch {
                    warnings.push(`Could not read dependency: ${relDep}`);
                }

                if (current.depth + 1 < maxDepth) {
                    toVisit.push({ file: depResolved, depth: current.depth + 1 });
                }
            }
        }
    }

    return {
        file: resolved,
        relativePath: path.relative(root, resolved),
        firstLevelImports,
        ownExports,
        dependencyExports,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Output formatter
// ---------------------------------------------------------------------------

function formatFileContext(ctx: FileContext): string {
    const parts: string[] = [];
    parts.push(`=== ${ctx.relativePath} ===`);

    if (ctx.warnings.length > 0) {
        parts.push(`⚠ Warnings:\n${ctx.warnings.map((w) => `  - ${w}`).join("\n")}`);
    }

    if (ctx.ownExports.length > 0) {
        parts.push(`\n--- Own exports (${ctx.ownExports.length}) ---`);
        for (const decl of ctx.ownExports) {
            parts.push(decl.lines.join("\n"));
        }
    } else {
        parts.push("\n(no exported declarations found)");
    }

    const depKeys = Object.keys(ctx.dependencyExports);
    if (depKeys.length > 0) {
        parts.push(`\n--- Dependency exports ---`);
        for (const dep of depKeys) {
            const decls = ctx.dependencyExports[dep]!;
            parts.push(`\n# ${dep} (${decls.length} exports)`);
            for (const decl of decls) {
                parts.push(decl.lines.join("\n"));
            }
        }
    }

    return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGetTestContext(server: McpServer): void {
    server.registerTool(
        "get_test_context",
        {
            description:
                "Reads the first-level relative imports of the given source files and " +
                "extracts only the exported types, interfaces, enums, constants and " +
                "function signatures — the minimum context needed to generate correct " +
                "mocks and imports in a test file. Does NOT return full implementations. " +
                "Use this BEFORE generating test content when the source file has complex " +
                "type dependencies.",
            inputSchema: GetTestContextSchema,
        },
        async (args) => {
            const rootResult = resolveRootPath(args.rootPath);
            if (!rootResult.ok) return rootPathErrorResponse(rootResult);
            const root = rootResult.root;

            const fileContexts: FileContext[] = [];

            for (const file of args.files) {
                const ctx = analyzeFileContext(file, root, args.maxDepth);
                fileContexts.push(ctx);
            }

            // Structured JSON output
            const structured = fileContexts.map((ctx) => ({
                file: ctx.relativePath,
                warnings: ctx.warnings,
                ownExports: ctx.ownExports.map((d) => ({
                    kind: d.kind,
                    name: d.name,
                    snippet: d.lines.join("\n"),
                })),
                firstLevelImports: ctx.firstLevelImports,
                dependencyExports: Object.fromEntries(
                    Object.entries(ctx.dependencyExports).map(([dep, decls]) => [
                        dep,
                        decls.map((d) => ({
                            kind: d.kind,
                            name: d.name,
                            snippet: d.lines.join("\n"),
                        })),
                    ])
                ),
            }));

            // Human-readable text for quick scanning
            const text = fileContexts.map(formatFileContext).join("\n\n");

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                root,
                                files: structured,
                                summary:
                                    `Analyzed ${fileContexts.length} file(s). ` +
                                    `Total own exports: ${structured.reduce((n, f) => n + f.ownExports.length, 0)}. ` +
                                    `Total dependency exports: ${structured.reduce((n, f) => n + Object.values(f.dependencyExports).flat().length, 0)}.`,
                                humanReadable: text,
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
