import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerProjectInfo } from "./tools/project-info.js";
import { registerGetChangedFiles } from "./tools/get-changed-files.js";
import { registerRunCoverage } from "./tools/run-coverage.js";
import { registerReadSourceFiles } from "./tools/read-source-files.js";
import { registerWriteTestFile } from "./tools/write-test-file.js";
import { registerGetTestContext } from "./tools/get-test-context.js";
import { registerGetTestGuidelines } from "./tools/get-test-guidelines.js";
import { registerListTestFiles } from "./tools/list-test-files.js";
import { registerPlan } from "./tools/plan.js";
import { registerHelp } from "./tools/help.js";

console.error("[mcp-tests] starting. node =", process.version, "cwd =", process.cwd());

const server = new McpServer({ name: "mcp-tests", version: "0.3.0" });

// ---------------------------------------------------------------------------
// Register tools
//
// Intended flow for the model:
//  0. plan              → read-only analysis: detect changed files, test gaps,
//                         build work plan and present it to the user for approval
//  --- after user confirms ---
//  1. get_test_guidelines → get framework-specific testing rules (once per project)
//  2. run_coverage        → measure baseline coverage
//  3. read_source_files   → read source + existing tests + import analysis
//  4. get_test_context    → extract type dependencies (optional, for complex files)
//  5. write_test_file     → create/update test files (NEVER touches source files)
//  6. run_coverage        → re-run to confirm coverage improved
// ---------------------------------------------------------------------------

registerPlan(server);
registerProjectInfo(server);
registerGetChangedFiles(server);
registerRunCoverage(server);
registerGetTestGuidelines(server);
registerReadSourceFiles(server);
registerGetTestContext(server);
registerListTestFiles(server);
registerWriteTestFile(server);
registerHelp(server);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error("MCP server failed:", err);
    process.exit(1);
});