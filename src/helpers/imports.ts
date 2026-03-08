import fs from "node:fs";
import path from "node:path";
import { readTsconfigJson } from "./repo.js";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface DetectedImport {
    /** El specifier original tal como aparece en el código fuente */
    original: string;
    /** Tipo de import */
    kind: "relative" | "package" | "alias" | "builtin";
    /**
     * Para imports relativos: el path reescrito relativo al test file.
     * Para el resto: igual que `original`.
     *
     * Listo para pegar directamente en el test file.
     */
    importPath: string;
    /** Los nombres importados: default, named, namespace */
    imports: {
        default: string | null;
        named: string[];
        namespace: string | null;
    };
}

export interface ImportsAnalysis {
    /** Path absoluto del archivo fuente analizado */
    sourceFile: string;
    /** Path absoluto donde se creará/existe el test file */
    testFile: string;
    /**
     * Lista de imports del archivo fuente con el path ya reescrito
     * para que funcionen desde la ubicación del test file.
     */
    imports: DetectedImport[];
    /**
     * Bloque de imports listo para copiar/pegar al inicio del test file.
     * Incluye todos los exports del fuente reescritos correctamente.
     */
    suggestedImportBlock: string;
    /**
     * Aliases de path detectados en tsconfig/jest config del proyecto
     * (ej. "@/*" → "src/*"). Usados para resolver paths con alias.
     */
    detectedAliases: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Regex para parsear imports estáticamente (sin AST completo)
// Cubre la gran mayoría de casos reales:
//   import Foo from '...'
//   import { a, b } from '...'
//   import * as Foo from '...'
//   import Foo, { a, b } from '...'
//   import type { ... } from '...'
// ---------------------------------------------------------------------------

/**
 * Matches static ES `import` statements (including `import type`).
 *
 * Capture groups:
 *   1 — bindings: the part before `from`, e.g.
 *         `* as Foo`          (namespace import)
 *         `{ foo, bar as b }` (named imports)
 *         `MyDefault`         (default import)
 *         `MyDefault, { foo }` (default + named)
 *       May be empty for bare side-effect imports (`import '...'`).
 *   2 — specifier: the module path inside quotes, e.g.
 *         `./utils`, `react`, `@/lib/db`
 *
 * Flags: `g` — must reset `lastIndex` before each use.
 */
const IMPORT_RE =
    /import\s+(?:type\s+)?(?:(\*\s+as\s+\w+|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s+)?['"]([^'"]+)['"]/g;

function parseImportLine(raw: string): {
    default: string | null;
    named: string[];
    namespace: string | null;
} {
    const result = { default: null as string | null, named: [] as string[], namespace: null as string | null };
    if (!raw) return result;

    const trimmed = raw.trim();

    // namespace: * as Foo
    const nsMatch = trimmed.match(/^\*\s+as\s+(\w+)/);
    if (nsMatch) {
        result.namespace = nsMatch[1] ?? null;
        return result;
    }

    // named: { a, b as c, ... } — puede venir sola o tras el default
    const namedMatch = trimmed.match(/\{([^}]*)\}/);
    if (namedMatch?.[1] !== undefined) {
        result.named = namedMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }

    // default: lo que queda antes de la coma (si hay), sin las llaves
    const defaultPart = trimmed.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
    if (defaultPart && !defaultPart.startsWith("*")) {
        result.default = defaultPart || null;
    }

    return result;
}

// ---------------------------------------------------------------------------
// Resolución de tsconfig paths / jest moduleNameMapper
// ---------------------------------------------------------------------------

interface PathAliases {
    [alias: string]: string;
}

function loadTsconfigAliases(root: string): PathAliases {
    const config = readTsconfigJson(root);
    if (!config) return {};

    const compilerOptions = config?.compilerOptions as { paths?: Record<string, string[]>; baseUrl?: string } | undefined;
    const compilerPaths: Record<string, string[]> = compilerOptions?.paths ?? {};
    const baseUrl: string = compilerOptions?.baseUrl ?? ".";
    const aliases: PathAliases = {};

    for (const [alias, targets] of Object.entries(compilerPaths)) {
        if (targets.length === 0) continue;
        // "@/*" → "src/*"  convierte el glob a prefix
        const aliasPrefix = alias.replace(/\/\*$/, "");
        const targetPrefix = path.resolve(root, baseUrl, (targets[0] ?? "").replace(/\/\*$/, ""));
        aliases[aliasPrefix] = targetPrefix;
    }

    return aliases;
}

// ---------------------------------------------------------------------------
// Función principal
// ---------------------------------------------------------------------------

/**
 * Analiza los imports estáticos de `sourceFile` y los reescribe
 * para que sean correctos cuando se usen desde `testFilePath`.
 */
export function analyzeImports(
    sourceFile: string,
    testFilePath: string,
    root: string
): ImportsAnalysis {
    const aliases = loadTsconfigAliases(root);

    let sourceContent: string = "";
    try {
        sourceContent = fs.readFileSync(sourceFile, "utf-8");
    } catch {
        return {
            sourceFile,
            testFile: testFilePath,
            imports: [],
            suggestedImportBlock: "",
            detectedAliases: aliases,
        };
    }

    const detectedImports: DetectedImport[] = [];
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;

    while ((match = IMPORT_RE.exec(sourceContent)) !== null) {
        const rawBindings = match[1] ?? "";
        const specifier = match[2];
        if (!specifier) continue;

        const kind = classifySpecifier(specifier, aliases);
        const importPath = kind === "relative"
            ? rewriteRelativePath(specifier, sourceFile, testFilePath)
            : resolveAlias(specifier, aliases) ?? specifier;

        detectedImports.push({
            original: specifier,
            kind,
            importPath,
            imports: parseImportLine(rawBindings),
        });
    }

    const suggestedImportBlock = buildImportBlock(detectedImports, sourceFile, testFilePath, root);

    return {
        sourceFile,
        testFile: testFilePath,
        imports: detectedImports,
        suggestedImportBlock,
        detectedAliases: aliases,
    };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function classifySpecifier(specifier: string, aliases: PathAliases): DetectedImport["kind"] {
    if (specifier.startsWith(".")) return "relative";
    if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return "builtin";
    for (const alias of Object.keys(aliases)) {
        if (specifier.startsWith(alias)) return "alias";
    }
    return "package";
}

/**
 * Reescribe un import relativo del archivo fuente para que funcione
 * desde la ubicación del test file.
 *
 * Ejemplo:
 *   sourceFile:   src/utils/format.ts
 *   testFilePath: src/utils/__tests__/format.test.ts
 *   specifier:    ../lib/helpers   →   ../../lib/helpers
 */
function rewriteRelativePath(
    specifier: string,
    sourceFile: string,
    testFilePath: string
): string {
    // Resolvemos el specifier desde el directorio del fuente
    const sourceDir = path.dirname(sourceFile);
    const resolved = path.resolve(sourceDir, specifier);

    // Calculamos el path relativo desde el directorio del test
    const testDir = path.dirname(testFilePath);
    let rel = path.relative(testDir, resolved);

    // path.relative puede devolver "foo" sin "./" — lo normalizamos
    if (!rel.startsWith(".")) rel = "./" + rel;

    // Preservar extensión si el original la tenía; si no, no añadir
    // (los bundlers/ts suelen preferir sin extensión en imports)
    return rel;
}

/**
 * Si el specifier usa un alias (ej. "@/utils/foo"),
 * intenta resolverlo a un path relativo desde el test file.
 * Si no puede, devuelve null para usar el alias tal cual.
 */
function resolveAlias(specifier: string, aliases: PathAliases): string | null {
    for (const [aliasPrefix, targetDir] of Object.entries(aliases)) {
        if (!specifier.startsWith(aliasPrefix)) continue;
        // "@/utils/foo"  con alias "@" → "src"  =>  "src/utils/foo"
        const rest = specifier.slice(aliasPrefix.length).replace(/^\//, "");
        const resolved = path.join(targetDir, rest);
        // Devolvemos path absoluto; el llamador lo reescribirá si es necesario
        return resolved;
    }
    return null;
}

/**
 * Construye el bloque de imports sugerido para el test file.
 * Incluye:
 *  1. El import del propio archivo bajo test (default export o named exports detectados)
 *  2. Todos los imports externos (packages, builtins) del fuente
 */
function buildImportBlock(
    imports: DetectedImport[],
    sourceFile: string,
    testFilePath: string,
    root: string
): string {
    const lines: string[] = [];

    // --- 1. Import del archivo bajo test ---
    const sourceDir = path.dirname(sourceFile);
    const testDir = path.dirname(testFilePath);
    let sourceFromTest = path.relative(testDir, sourceFile);
    if (!sourceFromTest.startsWith(".")) sourceFromTest = "./" + sourceFromTest;
    // Quitar extensión .ts/.tsx para el import (convención TypeScript)
    sourceFromTest = sourceFromTest.replace(/\.(ts|tsx)$/, "");

    // Detectar si el fuente tiene default export y/o named exports
    let sourceContent = "";
    try { sourceContent = fs.readFileSync(sourceFile, "utf-8"); } catch { /* empty */ }

    const hasDefault = /export\s+default\s/.test(sourceContent);
    const namedExports = extractNamedExports(sourceContent);

    if (hasDefault && namedExports.length > 0) {
        lines.push(`import ${toDefaultName(sourceFile)}, { ${namedExports.join(", ")} } from '${sourceFromTest}';`);
    } else if (hasDefault) {
        lines.push(`import ${toDefaultName(sourceFile)} from '${sourceFromTest}';`);
    } else if (namedExports.length > 0) {
        lines.push(`import { ${namedExports.join(", ")} } from '${sourceFromTest}';`);
    } else {
        // Fallback: wildcard
        lines.push(`import * as ${toDefaultName(sourceFile)} from '${sourceFromTest}';`);
    }

    lines.push("");

    // --- 2. Re-exportar imports externos relevantes (packages y builtins) ---
    // El modelo puede necesitarlos para mockearlos
    const externals = imports.filter((i) => i.kind === "package" || i.kind === "builtin");
    for (const imp of externals) {
        const binding = formatBinding(imp);
        if (binding) {
            lines.push(`import ${binding} from '${imp.importPath}';`);
        }
    }

    // --- 3. Imports relativos reescritos ---
    const relatives = imports.filter((i) => i.kind === "relative" || i.kind === "alias");
    for (const imp of relatives) {
        const binding = formatBinding(imp);
        const resolvedPath = imp.kind === "alias"
            ? (() => {
                const testDir2 = path.dirname(testFilePath);
                let rel = path.relative(testDir2, imp.importPath);
                if (!rel.startsWith(".")) rel = "./" + rel;
                return rel.replace(/\.(ts|tsx)$/, "");
            })()
            : imp.importPath.replace(/\.(ts|tsx)$/, "");

        if (binding) {
            lines.push(`import ${binding} from '${resolvedPath}';`);
        }
    }

    return lines.join("\n");
}

function formatBinding(imp: DetectedImport): string {
    const parts: string[] = [];
    if (imp.imports.namespace) return `* as ${imp.imports.namespace}`;
    if (imp.imports.default) parts.push(imp.imports.default);
    if (imp.imports.named.length > 0) parts.push(`{ ${imp.imports.named.join(", ")} }`);
    return parts.join(", ");
}

/** Genera el nombre del default import a partir del nombre del archivo */
function toDefaultName(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath));
    // kebab-case → camelCase
    return base.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}

/** Extrae los nombres de los exports nombrados del código fuente */
function extractNamedExports(content: string): string[] {
    const names = new Set<string>();

    // export const/let/var/function/class/type/interface foo
    const directRe = /export\s+(?:const|let|var|function|class|type|interface|enum)\s+([\w$]+)/g;
    let m: RegExpExecArray | null;
    while ((m = directRe.exec(content)) !== null) {
        const name = m[1];
        if (name) names.add(name);
    }

    // export { foo, bar as baz }
    const braceRe = /export\s+\{([^}]+)\}/g;
    while ((m = braceRe.exec(content)) !== null) {
        (m[1] ?? "").split(",").forEach((part) => {
            const name = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (name && name !== "default") names.add(name);
        });
    }

    return [...names];
}

const NODE_BUILTINS = new Set([
    "fs", "path", "os", "crypto", "http", "https", "url", "util",
    "stream", "buffer", "events", "child_process", "cluster", "net",
    "dns", "readline", "zlib", "assert", "module", "process", "v8",
    "vm", "worker_threads", "perf_hooks", "inspector", "tty", "dgram",
]);
