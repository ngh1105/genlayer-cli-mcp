import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: process.env
});

const client = new Client({
  name: "genlayer-cli-mcp-smoke",
  version: "0.1.0"
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(JSON.stringify({ tools: tools.tools.map((tool) => tool.name) }, null, 2));

  const checkTools = await client.callTool({
    name: "check_tools",
    arguments: {}
  });
  console.log(JSON.stringify({ check_tools: checkTools.content }, null, 2));

  const genlayerVersion = await client.callTool({
    name: "genlayer",
    arguments: {
      args: ["--version"]
    }
  });
  console.log(JSON.stringify({ genlayer_version: genlayerVersion.content }, null, 2));

  const genvmLintVersion = await client.callTool({
    name: "genvm_lint",
    arguments: {
      args: ["--version"]
    }
  });
  console.log(JSON.stringify({ genvm_lint_version: genvmLintVersion.content }, null, 2));
} finally {
  await client.close();
}
