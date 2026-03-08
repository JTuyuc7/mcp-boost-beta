import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// In-memory cache for package.json and tsconfig.json
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const packageJsonCache = new Map<string, CacheEntry<Record<string, unknown> | null>>();
const tsconfigCache = new Map<string, CacheEntry<Record<string, unknown> | null>>();

/**
 * Invalidates all caches. Useful for testing or when you know files have changed.
 */
export function invalidateCache(): void {
    packageJsonCache.clear();
    tsconfigCache.clear();
}

/**
 * Invalidates cache for a specific root path.
 */
export function invalidateCacheForRoot(root: string): void {
    packageJsonCache.delete(root);
    tsconfigCache.delete(root);
}

/**
 * Resultado de resolver el rootPath.
 *
 * - ok: true  → `root` contiene la ruta validada, listo para usar.
 * - ok: false → `error` describe el problema; el tool debe devolverlo al modelo
 *               sin ejecutar ninguna acción. `inferredPath` es la ruta que se
 *               habría usado como fallback, para que el modelo pueda confirmarla.
 */
export type RootPathResult =
    | { ok: true; root: string }
    | { ok: false; error: string; inferredPath: string };

/**
 * Resuelve y valida el rootPath.
 *
 * Si `rootPath` NO se provee:
 *   - Intenta inferirlo subiendo desde process.cwd() buscando .git / package.json.
 *   - Devuelve ok=false con el path inferido y un mensaje claro para que el modelo
 *     confirme con el usuario antes de proceder.
 *
 * Si `rootPath` SÍ se provee:
 *   - Verifica que el directorio exista en disco.
 *   - Devuelve ok=true si es válido, ok=false si no existe.
 */
export function resolveRootPath(rootPath: string | undefined): RootPathResult {
    if (!rootPath) {
        // Inferir como fallback informativo
        const inferred = findRepoRoot(process.cwd());
        return {
            ok: false,
            error:
                `'rootPath' was not provided. ` +
                `The server would have inferred '${inferred}' from process.cwd(), ` +
                `but executing commands against an unconfirmed path is not allowed. ` +
                `Please re-call this tool with rootPath set to the absolute path of ` +
                `the repository you want to work with (e.g. rootPath: "${inferred}").`,
            inferredPath: inferred,
        };
    }

    if (!fs.existsSync(rootPath)) {
        return {
            ok: false,
            error:
                `rootPath '${rootPath}' does not exist on disk. ` +
                `Check the path and try again.`,
            inferredPath: rootPath,
        };
    }

    if (!fs.statSync(rootPath).isDirectory()) {
        return {
            ok: false,
            error:
                `rootPath '${rootPath}' is a file, not a directory. ` +
                `Provide the root folder of the repository.`,
            inferredPath: path.dirname(rootPath),
        };
    }

    return { ok: true, root: rootPath };
}

/**
 * Builds the standard MCP error response for an unresolvable rootPath.
 * Use this in every tool immediately after a failed `resolveRootPath` call
 * to avoid repeating the same error-return boilerplate.
 */
export function rootPathErrorResponse(
    resolved: Extract<RootPathResult, { ok: false }>
) {
    return {
        content: [
            {
                type: "text" as const,
                text: JSON.stringify(
                    {
                        success: false,
                        error: resolved.error,
                        inferredPath: resolved.inferredPath,
                    },
                    null,
                    2
                ),
            },
        ],
        isError: true as const,
    };
}

/**
 * Sube desde `startDir` buscando el primer directorio que contenga `.git`
 * o `package.json`. Devuelve `startDir` si llega a la raíz del FS sin encontrar.
 */
export function findRepoRoot(startDir: string): string {
    let current = startDir;
    while (true) {
        if (
            fs.existsSync(path.join(current, ".git")) ||
            fs.existsSync(path.join(current, "package.json"))
        ) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) return startDir;
        current = parent;
    }
}

/**
 * Lee y parsea el package.json en `root`. Devuelve null si no existe o hay error.
 * Utiliza caché en memoria con TTL de 5 minutos para mejorar performance.
 */
export function readPackageJson(root: string): Record<string, unknown> | null {
    const now = Date.now();
    const cached = packageJsonCache.get(root);

    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        // Cache hit
        return cached.data;
    }

    // Cache miss - read from disk
    const pkgPath = path.join(root, "package.json");
    if (!fs.existsSync(pkgPath)) {
        packageJsonCache.set(root, { data: null, timestamp: now });
        return null;
    }

    try {
        const data = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        packageJsonCache.set(root, { data, timestamp: now });
        return data;
    } catch {
        packageJsonCache.set(root, { data: null, timestamp: now });
        return null;
    }
}

/**
 * Lee y parsea el primer tsconfig encontrado en `root` (tsconfig.json, tsconfig.base.json, etc.).
 * Devuelve null si no existe o hay error. Utiliza caché en memoria con TTL de 5 minutos.
 * Elimina comentarios antes de parsear.
 */
export function readTsconfigJson(root: string): Record<string, unknown> | null {
    const now = Date.now();
    const cacheKey = root;
    const cached = tsconfigCache.get(cacheKey);

    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
        // Cache hit
        return cached.data;
    }

    // Cache miss - try multiple tsconfig locations
    const candidates = [
        path.join(root, "tsconfig.json"),
        path.join(root, "tsconfig.base.json"),
        path.join(root, "tsconfig.app.json"),
    ];

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) continue;
        try {
            // tsconfig puede tener comentarios, hacemos un parse tolerante
            const raw = fs.readFileSync(candidate, "utf-8")
                .replace(/\/\/[^\n]*/g, "")      // strip // comments
                .replace(/\/\*[\s\S]*?\*\//g, ""); // strip /* */ comments
            const data = JSON.parse(raw);
            tsconfigCache.set(cacheKey, { data, timestamp: now });
            return data;
        } catch {
            // tsconfig malformado — probar siguiente
            continue;
        }
    }

    // No se encontró ningún tsconfig válido
    tsconfigCache.set(cacheKey, { data: null, timestamp: now });
    return null;
}

/** Extensiones de código fuente permitidas */
export const SOURCE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
]);

/** Extensiones de archivos de test */
export const TEST_EXTENSIONS = new Set([
    ".test.ts", ".test.tsx", ".test.js", ".test.jsx",
    ".spec.ts", ".spec.tsx", ".spec.js", ".spec.jsx",
]);

/** Devuelve true si el archivo es un test file */
export function isTestFile(filePath: string): boolean {
    return (
        filePath.includes(".test.") ||
        filePath.includes(".spec.") ||
        filePath.includes("__tests__")
    );
}

/**
 * Dado un archivo fuente, intenta encontrar su archivo de test
 * buscando en ubicaciones comunes (mismo directorio, __tests__).
 */
export function findTestFileForSource(
    sourceFile: string,
    root: string
): string | null {
    const dir = path.dirname(sourceFile);
    const ext = path.extname(sourceFile);
    const base = path.basename(sourceFile, ext);

    const candidates = [
        // mismo directorio
        path.join(dir, `${base}.test${ext}`),
        path.join(dir, `${base}.spec${ext}`),
        // __tests__ hermano
        path.join(dir, "__tests__", `${base}.test${ext}`),
        path.join(dir, "__tests__", `${base}.spec${ext}`),
        // __tests__ en la raíz del proyecto
        path.join(root, "__tests__", path.relative(root, dir), `${base}.test${ext}`),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Detecta la convención de test files del proyecto inspeccionando
 * los archivos de test existentes en el árbol de directorios.
 *
 * - "colocated"  → los test files viven junto al fuente (src/foo/bar.test.ts)
 * - "__tests__"  → los test files viven en una carpeta __tests__ hermana (src/foo/__tests__/bar.test.ts)
 * - "root"       → existe una carpeta __tests__ en la raíz del proyecto
 * - "unknown"    → no se encontraron test files para inferir la convención
 */
export type TestConvention = "colocated" | "__tests__" | "root" | "unknown";

export function detectTestConvention(root: string): TestConvention {
    // Busca hasta 200 archivos de test en el repo para inferir convención
    const found = findTestFilesInDir(root, 200);

    if (found.length === 0) return "unknown";

    let colocated = 0;
    let inlineTests = 0;
    let rootTests = 0;

    for (const f of found) {
        const rel = path.relative(root, f);
        const parts = rel.split(path.sep);
        if (parts[0] === "__tests__") {
            rootTests++;
        } else if (parts.some((p) => p === "__tests__")) {
            inlineTests++;
        } else {
            colocated++;
        }
    }

    if (rootTests >= inlineTests && rootTests >= colocated) return "root";
    if (inlineTests >= colocated) return "__tests__";
    return "colocated";
}

/**
 * Directory names that should be skipped during any recursive file walk.
 * Exported so every tool can reuse the same ignore list.
 */
export const WALK_IGNORE_DIRS = new Set([
    "node_modules", ".git", ".next", ".nuxt", "dist",
    "build", "out", ".turbo", "coverage", ".cache", ".vscode", ".idea",
]);

/**
 * Iterates all files under `dir`, depth-first, skipping {@link WALK_IGNORE_DIRS}.
 * Yields absolute file paths. Stops after `maxFiles` files have been yielded.
 *
 * Replaces one-off recursive walk helpers across the codebase.
 */
export function* walkDir(dir: string, maxFiles: number): Generator<string> {
    let count = 0;
    const stack = [dir];

    while (stack.length > 0 && count < maxFiles) {
        const current = stack.pop()!;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (count >= maxFiles) return;
            if (entry.isDirectory()) {
                if (!WALK_IGNORE_DIRS.has(entry.name)) {
                    stack.push(path.join(current, entry.name));
                }
            } else if (entry.isFile()) {
                yield path.join(current, entry.name);
                count++;
            }
        }
    }
}

/** Recorre recursivamente `dir` buscando test files, hasta `maxFiles`. */
function findTestFilesInDir(dir: string, maxFiles: number): string[] {
    const results: string[] = [];
    for (const file of walkDir(dir, maxFiles)) {
        if (isTestFile(file)) results.push(file);
    }
    return results;
}

/**
 * Dado un archivo fuente SIN test file existente, sugiere la ruta donde
 * debería crearse el test, respetando la convención detectada en el proyecto.
 *
 * Nunca devuelve null — siempre hay una sugerencia concreta lista para
 * pasarle directamente a `write_test_file`.
 */
export function suggestTestFilePath(
    sourceFile: string,
    root: string,
    convention: TestConvention
): string {
    const dir = path.dirname(sourceFile);
    const ext = path.extname(sourceFile);
    const base = path.basename(sourceFile, ext);

    switch (convention) {
        case "__tests__":
            // src/foo/__tests__/bar.test.ts
            return path.join(dir, "__tests__", `${base}.test${ext}`);

        case "root":
            // <root>/__tests__/src/foo/bar.test.ts
            return path.join(root, "__tests__", path.relative(root, dir), `${base}.test${ext}`);

        case "colocated":
        case "unknown":
        default:
            // src/foo/bar.test.ts  (colocated es el default más seguro)
            return path.join(dir, `${base}.test${ext}`);
    }
}
