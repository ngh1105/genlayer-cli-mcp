# GenLayer CLI MCP

MCP server for AI agents that need to work with GenLayer projects.

It exposes:

- `genlayer`: full access to the GenLayer CLI
- `genvm_lint`: access to `genvm-lint`
- `genlayer_deploy`: deploys contracts with `genlayer-js`
- `check_tools`: verifies local tool availability and private key config

The server uses stdio transport and executes commands with `spawn(command, args)`.

## Requirements

- Node.js 18+
- GenLayer CLI available on `PATH`
- GenVM linter available on `PATH`

Install the external tools:

```powershell
npm install -g genlayer
py -3.12 -m pip install genvm-linter
```

Check them:

```powershell
genlayer --version
genvm-lint --version
```

## MCP Config

If this package is published to npm:

```json
{
  "mcpServers": {
    "genlayer-cli": {
      "command": "npx",
      "args": ["-y", "genlayer-cli-mcp"],
      "env": {
        "GENLAYER_PRIVATE_KEY": "0x_your_private_key_here"
      }
    }
  }
}
```

If running from this repository:

```json
{
  "mcpServers": {
    "genlayer-cli": {
      "command": "node",
      "args": ["E:\\genlayer-cli-mcp\\dist\\index.js"],
      "env": {
        "GENLAYER_PRIVATE_KEY": "0x_your_private_key_here"
      }
    }
  }
}
```

Accepted private key env names:

- `GENLAYER_PRIVATE_KEY`
- `GENLAYER_PRV_KEY`
- `GENLAYER_PRIVKEY`
- `PRIVATE_KEY`

The private key may be either `0x` plus 64 hex characters or raw 64 hex characters. If the configured key is missing or invalid, `genlayer_deploy` generates a new private key and deploys with it in the same tool call. When a new key is generated, the response includes it so you can save it.

## Local Development

```powershell
cd E:\genlayer-cli-mcp
npm install
npm run build
npm run smoke
```

Run the server:

```powershell
node E:\genlayer-cli-mcp\dist\index.js
```

Package locally:

```powershell
npm pack
```

Publish to npm:

```powershell
npm login
npm publish --access public
```

## Tools

### `check_tools`

Checks `node`, `genlayer`, `python`, `genvm-lint`, and private key config.

Example AI prompt:

```text
Use MCP tool check_tools from genlayer-cli.
```

### `genlayer`

Runs `genlayer <args...>` with full command access.

Example:

```json
{
  "args": ["--version"]
}
```

Example deploy through the raw CLI:

```json
{
  "args": [
    "deploy",
    "--contract",
    "E:\\path\\to\\contract.py",
    "--rpc",
    "http://localhost:4000/api"
  ],
  "timeoutMs": 120000
}
```

### `genvm_lint`

Runs `genvm-lint <args...>`.

Example:

```json
{
  "args": ["check", "E:\\path\\to\\contract.py"],
  "timeoutMs": 120000
}
```

### `genlayer_deploy`

Deploys an Intelligent Contract through `genlayer-js`.

This is the recommended deploy tool for AI agents because it handles private key fallback:

1. Use `privateKey` from the tool input if valid.
2. Otherwise use private key from MCP config env if valid.
3. Otherwise generate a new private key.
4. Deploy with the selected/generated private key immediately.

Example:

```json
{
  "contractPath": "E:\\path\\to\\contract.py",
  "chain": "localnet",
  "rpcUrl": "http://localhost:4000/api",
  "autoFundLocalnet": true,
  "waitForReceipt": true,
  "receiptStatus": "ACCEPTED",
  "timeoutMs": 120000
}
```

Optional fields:

```json
{
  "privateKey": "0x...",
  "args": [],
  "kwargs": {},
  "cwd": "E:\\project",
  "leaderOnly": false,
  "consensusMaxRotations": 5,
  "initializeConsensus": true,
  "fundAmount": 10,
  "receiptRetries": 50,
  "receiptIntervalMs": 5000,
  "exposePrivateKey": false
}
```

Supported chains:

- `localnet`
- `studionet`
- `testnetAsimov`
- `testnetBradbury`

## Agent Setup Examples

Use the same MCP server definition for coding agents that support MCP over stdio. Replace the private key with your own testnet/local key, or leave it invalid if you want `genlayer_deploy` to generate a fresh key during deploy.

### Codex

Add this MCP server to your Codex MCP configuration:

```json
{
  "mcpServers": {
    "genlayer-cli": {
      "command": "npx",
      "args": ["-y", "genlayer-cli-mcp"],
      "env": {
        "GENLAYER_PRIVATE_KEY": "0x_your_private_key_here"
      }
    }
  }
}
```

Suggested Codex prompt:

```text
Use MCP tool check_tools from genlayer-cli and tell me whether deploy can use the configured private key.

Then lint my GenLayer contract with genvm_lint.

If lint passes, deploy it with genlayer_deploy using:
{
  "contractPath": "E:\\path\\to\\contract.py",
  "chain": "localnet",
  "rpcUrl": "http://localhost:4000/api",
  "autoFundLocalnet": true,
  "waitForReceipt": true,
  "receiptStatus": "ACCEPTED"
}
```

### Antigravity

Add the MCP server in Antigravity's MCP settings:

```json
{
  "mcpServers": {
    "genlayer-cli": {
      "command": "npx",
      "args": ["-y", "genlayer-cli-mcp"],
      "env": {
        "GENLAYER_PRIVATE_KEY": "0x_your_private_key_here"
      }
    }
  }
}
```

Suggested Antigravity prompt:

```text
Use the genlayer-cli MCP server.

First call check_tools.
Then run genvm_lint on:
{
  "args": ["check", "E:\\path\\to\\contract.py"]
}

If the contract is valid, call genlayer_deploy. If the configured MCP private key is invalid, let the MCP tool generate a new private key and deploy with it automatically.
```

### Claude Code

Add the server with Claude Code's MCP add command:

```powershell
claude mcp add genlayer-cli -- npx -y genlayer-cli-mcp
```

If your Claude Code setup supports environment variables in MCP config, add:

```json
{
  "GENLAYER_PRIVATE_KEY": "0x_your_private_key_here"
}
```

Alternative local-source command:

```powershell
claude mcp add genlayer-cli -- node E:\genlayer-cli-mcp\dist\index.js
```

Suggested Claude Code prompt:

```text
Use the genlayer-cli MCP server.

1. Call check_tools.
2. Run genvm_lint for E:\path\to\contract.py.
3. If lint succeeds, deploy with genlayer_deploy.
4. If the private key in MCP config is missing or invalid, generate a new private key and deploy with that generated key in the same tool call.

Arguments:
{
  "contractPath": "E:\\path\\to\\contract.py",
  "chain": "localnet",
  "rpcUrl": "http://localhost:4000/api",
  "autoFundLocalnet": true,
  "waitForReceipt": true,
  "receiptStatus": "ACCEPTED"
}
```

## Security

This MCP server intentionally exposes full GenLayer command access. AI agents can run state-changing commands such as `deploy`, `write`, `up`, `stop`, and `init`.

Do not put a mainnet private key in MCP config unless you trust the AI client and all enabled tools.
