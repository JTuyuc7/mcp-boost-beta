/**
 * Tool: get_test_guidelines
 *
 * Devuelve instrucciones específicas de testing según el framework y las
 * librerías detectadas en el proyecto. NO genera tests, solo da las reglas
 * y patrones que el modelo debe seguir al generar tests.
 */

import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRootPath, rootPathErrorResponse, readPackageJson } from "../helpers/repo.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const GetTestGuidelinesSchema = {
    rootPath: z
        .string()
        .describe(
            "Absolute path to the repository root. Must be provided explicitly — " +
            "never infer it from cwd."
        ),
    focusFile: z
        .string()
        .optional()
        .describe(
            "Optional: absolute or relative path to the source file you are testing. " +
            "When provided, the guidelines will be tailored to the file's location " +
            "(e.g., API route vs. React component vs. utility function)."
        ),
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

interface DetectedDeps {
    hasReact: boolean;
    hasNextJs: boolean;
    hasVue: boolean;
    hasAngular: boolean;
    hasExpress: boolean;
    hasFastify: boolean;
    hasTestingLibrary: boolean;
    hasEnzyme: boolean;
    hasJest: boolean;
    hasVitest: boolean;
    hasMsw: boolean;        // Mock Service Worker
    hasPrisma: boolean;
    hasDrizzle: boolean;
    hasZod: boolean;
    hasReactQuery: boolean;
    hasRedux: boolean;
    hasZustand: boolean;
    hasTrpc: boolean;
}

function detectDeps(root: string): DetectedDeps {
    const rawPkg = readPackageJson(root) ?? {};
    const toRec = (v: unknown): Record<string, unknown> =>
        v !== null && typeof v === "object" && !Array.isArray(v)
            ? (v as Record<string, unknown>)
            : {};

    const allDeps: Record<string, unknown> = {
        ...toRec(rawPkg["dependencies"]),
        ...toRec(rawPkg["devDependencies"]),
        ...toRec(rawPkg["peerDependencies"]),
    };

    const has = (...names: string[]) => names.some((n) => n in allDeps);

    return {
        hasReact: has("react"),
        hasNextJs: has("next"),
        hasVue: has("vue"),
        hasAngular: has("@angular/core"),
        hasExpress: has("express"),
        hasFastify: has("fastify"),
        hasTestingLibrary: has("@testing-library/react", "@testing-library/vue"),
        hasEnzyme: has("enzyme"),
        hasJest: has("jest", "@jest/globals"),
        hasVitest: has("vitest"),
        hasMsw: has("msw"),
        hasPrisma: has("@prisma/client", "prisma"),
        hasDrizzle: has("drizzle-orm"),
        hasZod: has("zod"),
        hasReactQuery: has("@tanstack/react-query", "react-query"),
        hasRedux: has("@reduxjs/toolkit", "redux"),
        hasZustand: has("zustand"),
        hasTrpc: has("@trpc/server", "@trpc/client"),
    };
}

type FileRole =
    | "api-route-next"
    | "react-component"
    | "react-hook"
    | "utility"
    | "service"
    | "model"
    | "trpc-router"
    | "unknown";

function detectFileRole(focusFile: string | undefined, root: string, deps: DetectedDeps): FileRole {
    if (!focusFile) return "unknown";

    const rel = path.isAbsolute(focusFile)
        ? path.relative(root, focusFile)
        : focusFile;

    const norm = rel.replace(/\\/g, "/");

    // Next.js API routes
    if (deps.hasNextJs && (norm.includes("pages/api/") || norm.includes("app/api/"))) {
        return "api-route-next";
    }
    // tRPC routers
    if (norm.includes("router") || norm.includes("trpc")) return "trpc-router";
    // React hook
    if (/use[A-Z]/.test(path.basename(norm))) return "react-hook";
    // React component (.tsx, or components/ folder)
    if (norm.endsWith(".tsx") || norm.includes("component")) return "react-component";
    // Service / repository layer
    if (norm.includes("service") || norm.includes("repository") || norm.includes("repo")) {
        return "service";
    }
    // Model / schema
    if (norm.includes("model") || norm.includes("schema") || norm.includes("entity")) {
        return "model";
    }
    return "utility";
}

// ---------------------------------------------------------------------------
// Guidelines builders
// ---------------------------------------------------------------------------

interface GuidelinesSection {
    title: string;
    rules: string[];
}

function buildGeneralRules(deps: DetectedDeps): GuidelinesSection {
    const runner = deps.hasVitest ? "vitest" : "jest";
    const importRunner = deps.hasVitest
        ? `import { describe, it, expect, vi } from 'vitest';`
        : `import { describe, it, expect, jest } from '@jest/globals';`;

    return {
        title: "General Testing Rules",
        rules: [
            `Test runner: **${runner}**. Always import from '${deps.hasVitest ? "vitest" : "@jest/globals"}' — never use globals implicitly.`,
            `Import line: \`${importRunner}\``,
            "Structure: one \`describe\` block per function/component, one \`it\` per behavior.",
            "Naming: \`it('should <do X> when <condition>')\` — no 'test' keyword.",
            "Arrange / Act / Assert pattern in every test. Separate sections with blank lines.",
            "Never test implementation details — test observable behavior only.",
            "Mock external modules at the top of the file with \`vi.mock()\` / \`jest.mock()\`.",
            "Reset mocks in \`beforeEach\` to avoid test pollution.",
            "One assertion per test when possible; avoid \`expect\` chains > 3.",
        ],
    };
}

function buildReactRules(deps: DetectedDeps): GuidelinesSection {
    const lib = deps.hasTestingLibrary
        ? "@testing-library/react"
        : deps.hasEnzyme
        ? "enzyme"
        : null;

    const rules = [
        `UI testing library: **${lib ?? "none detected"}**`,
    ];

    if (deps.hasTestingLibrary) {
        rules.push(
            "Import: `import { render, screen, userEvent } from '@testing-library/react'`",
            "Always wrap renders in `it(...)` — never at the module level.",
            "Query preference: getByRole > getByText > getByTestId. Avoid getByClassName.",
            "Use `userEvent.setup()` for interactions — never call `fireEvent` directly.",
            "Wrap async state updates in `await act(async () => { ... })`.",
            "Cleanup is automatic — do NOT call `cleanup()` manually.",
            "Mock `next/navigation` hooks: `vi.mock('next/navigation', () => ({ useRouter: vi.fn(() => ({ push: vi.fn() })) }))`",
        );
    }

    return { title: "React Component Testing", rules };
}

function buildHookRules(): GuidelinesSection {
    return {
        title: "React Hook Testing",
        rules: [
            "Use `renderHook` from `@testing-library/react` to test custom hooks.",
            "Example: `const { result } = renderHook(() => useMyHook(initialProps))`",
            "Access state via `result.current`. Mutations must be wrapped in `act()`.",
            "For hooks that depend on context providers, pass a `wrapper` to `renderHook`.",
            "Test side effects (API calls, subscriptions) by mocking the underlying module.",
        ],
    };
}

function buildNextApiRules(): GuidelinesSection {
    return {
        title: "Next.js API Route Testing",
        rules: [
            "For Pages Router (`pages/api`): import and call the handler function directly.",
            "Mock `req` and `res` objects — use `{ method, body, query }` for req and `{ json, status, end }` for res.",
            "For App Router (`app/api`): import and call the exported `GET`, `POST`, etc. functions.",
            "Mock `next/server` objects: `new Request(url, { method, body: JSON.stringify(...) })`",
            "Always assert both status code and response body.",
            "Mock database/ORM calls (Prisma, Drizzle) — never hit a real database in unit tests.",
            "Example mock: `vi.mock('@/lib/db', () => ({ db: { user: { findFirst: vi.fn() } } }))`",
        ],
    };
}

function buildServiceRules(deps: DetectedDeps): GuidelinesSection {
    const rules = [
        "Service tests are pure unit tests — mock ALL external I/O (DB, HTTP, filesystem).",
        "Test happy path + every distinct error path.",
    ];

    if (deps.hasPrisma) {
        rules.push(
            "Mock Prisma: `vi.mock('@/lib/prisma', () => ({ prisma: { <model>: { findFirst: vi.fn(), create: vi.fn() } } }))`",
            "Use `vi.mocked(prisma.<model>.findFirst).mockResolvedValue(...)` to set return values per test."
        );
    }

    if (deps.hasDrizzle) {
        rules.push(
            "Mock Drizzle db: `vi.mock('@/lib/db')` then mock the chained query methods.",
            "Drizzle chains are hard to mock individually — consider wrapping queries in a repository layer."
        );
    }

    if (deps.hasMsw) {
        rules.push(
            "For HTTP calls, prefer MSW handlers over `vi.mock('node-fetch')` or axios mocks.",
            "Setup: `beforeAll(() => server.listen())`, `afterEach(() => server.resetHandlers())`, `afterAll(() => server.close())`"
        );
    }

    return { title: "Service / Repository Testing", rules };
}

function buildTrpcRules(): GuidelinesSection {
    return {
        title: "tRPC Router Testing",
        rules: [
            "Test tRPC procedures via `createCaller` — do NOT make HTTP calls.",
            "Example: `const caller = appRouter.createCaller({ session: null })`",
            "Test that protected procedures throw `TRPCError` with code `UNAUTHORIZED` when session is null.",
            "Mock context factories to inject test sessions: `createTestContext({ userId: 'u1' })`",
            "Test input validation by passing invalid inputs and expecting `ZodError` or `BAD_REQUEST`.",
        ],
    };
}

function buildMockingRules(deps: DetectedDeps): GuidelinesSection {
    const rules = [
        "Module mocks must be declared at the top of the file, before any imports.",
        "Use `vi.fn()` / `jest.fn()` for function mocks — always type the return value.",
    ];

    if (deps.hasReactQuery) {
        rules.push(
            "Mock `@tanstack/react-query` hooks: `vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }))`",
            "Use `vi.mocked(useQuery).mockReturnValue({ data: ..., isLoading: false, isError: false })`"
        );
    }

    if (deps.hasRedux) {
        rules.push(
            "For Redux: use `configureStore` with test reducers, wrap components in `<Provider store={testStore}>`.",
            "Never mock the Redux store object directly."
        );
    }

    if (deps.hasZustand) {
        rules.push(
            "For Zustand: reset store state in `beforeEach` using the store's reset action or `useMyStore.setState(initialState)`."
        );
    }

    rules.push(
        "For timers: use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach`.",
        "For environment variables: set `process.env.MY_VAR = 'test'` in `beforeEach` and delete in `afterEach`."
    );

    return { title: "Mocking Patterns", rules };
}

function buildUtilityRules(): GuidelinesSection {
    return {
        title: "Utility / Pure Function Testing",
        rules: [
            "Pure functions need no mocks — test input/output directly.",
            "Use `it.each` or `describe.each` for parameterized cases with many input variations.",
            "Test boundary conditions: empty string, 0, null, undefined, very large numbers.",
            "For async utilities, test both resolved and rejected cases.",
            "Cover every branch of conditional logic — aim for 100% branch coverage on pure functions.",
        ],
    };
}

function buildCoverageRules(): GuidelinesSection {
    return {
        title: "Coverage Targets",
        rules: [
            "Aim for ≥ 80% statement coverage on new files.",
            "Prioritize branch coverage over line coverage — uncovered branches = untested behaviors.",
            "Do NOT write tests just to hit coverage numbers — every test must assert something meaningful.",
            "Use `/* c8 ignore next */` or `/* istanbul ignore next */` to skip unreachable guard code.",
        ],
    };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

function buildGuidelines(
    deps: DetectedDeps,
    role: FileRole
): GuidelinesSection[] {
    const sections: GuidelinesSection[] = [];

    sections.push(buildGeneralRules(deps));

    switch (role) {
        case "react-component":
            sections.push(buildReactRules(deps));
            sections.push(buildMockingRules(deps));
            break;
        case "react-hook":
            sections.push(buildHookRules());
            sections.push(buildMockingRules(deps));
            break;
        case "api-route-next":
            sections.push(buildNextApiRules());
            sections.push(buildMockingRules(deps));
            break;
        case "service":
        case "model":
            sections.push(buildServiceRules(deps));
            sections.push(buildMockingRules(deps));
            break;
        case "trpc-router":
            sections.push(buildTrpcRules());
            sections.push(buildMockingRules(deps));
            break;
        default:
            sections.push(buildUtilityRules());
            sections.push(buildMockingRules(deps));
            break;
    }

    sections.push(buildCoverageRules());

    return sections;
}

function formatGuidelines(sections: GuidelinesSection[]): string {
    return sections
        .map(
            (s) =>
                `## ${s.title}\n\n${s.rules.map((r) => `- ${r}`).join("\n")}`
        )
        .join("\n\n");
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerGetTestGuidelines(server: McpServer): void {
    server.registerTool(
        "get_test_guidelines",
        {
            description:
                "Returns framework-specific testing guidelines and patterns for the project. " +
                "Detects the test runner (jest/vitest), UI framework (React/Next.js/Vue), " +
                "data layer (Prisma/Drizzle) and other libraries to produce tailored " +
                "instructions. Call this ONCE before generating any tests in a new project " +
                "or when you are unsure about the testing patterns to use.",
            inputSchema: GetTestGuidelinesSchema,
        },
        async (args) => {
            const rootResult = resolveRootPath(args.rootPath);
            if (!rootResult.ok) return rootPathErrorResponse(rootResult);
            const root = rootResult.root;

            const deps = detectDeps(root);
            const role = detectFileRole(args.focusFile, root, deps);
            const sections = buildGuidelines(deps, role);
            const markdown = formatGuidelines(sections);

            // Detect tsconfig paths presence for path alias note
            const tsconfigPath = path.join(root, "tsconfig.json");
            let hasPathAliases = false;
            try {
                const raw = fs.readFileSync(tsconfigPath, "utf-8");
                hasPathAliases = raw.includes('"paths"');
            } catch { /* ignore */ }

            const detectedInfo = {
                testRunner: deps.hasVitest ? "vitest" : deps.hasJest ? "jest" : "unknown",
                frameworks: [
                    deps.hasNextJs && "next.js",
                    deps.hasReact && !deps.hasNextJs && "react",
                    deps.hasVue && "vue",
                    deps.hasAngular && "angular",
                    deps.hasExpress && "express",
                    deps.hasFastify && "fastify",
                ].filter(Boolean),
                uiTestingLibrary: deps.hasTestingLibrary
                    ? "@testing-library"
                    : deps.hasEnzyme
                    ? "enzyme"
                    : "none",
                dataLayer: [
                    deps.hasPrisma && "prisma",
                    deps.hasDrizzle && "drizzle-orm",
                ].filter(Boolean),
                otherLibs: [
                    deps.hasMsw && "msw",
                    deps.hasReactQuery && "@tanstack/react-query",
                    deps.hasRedux && "redux",
                    deps.hasZustand && "zustand",
                    deps.hasTrpc && "trpc",
                    deps.hasZod && "zod",
                ].filter(Boolean),
                fileRole: role,
                hasPathAliases,
            };

            const pathAliasNote = hasPathAliases
                ? "\n\n> ⚠ **Path aliases detected** — when importing from the source file under test, " +
                  "use the alias (e.g., `@/lib/utils`) rather than a relative path. " +
                  "Use `read_source_files` to get the `suggestedImportBlock` with correct paths."
                : "";

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                detectedSetup: detectedInfo,
                                guidelines: markdown + pathAliasNote,
                                sectionsCount: sections.length,
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
