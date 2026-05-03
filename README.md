# GenLayer CLI MCP

MCP server exposing full command access to:

- `genlayer`
- `genvm-lint`
- `genlayer-js` deploy helper with private key input/generation

The server uses stdio transport and runs commands with `spawn(command, args)`, not shell interpolation.

## Requirements

- Node.js 18+
- GenLayer CLI on `PATH`

```powershell
npm install -g genlayer
genlayer --version
```

- GenVM linter on `PATH`

```powershell
pip install genvm-linter
genvm-lint --version
```

If `genvm-lint` exists but exits immediately with no output, reinstall it in an active Python environment and make sure the generated script points to an existing Python executable.

## Install

```powershell
npm install
npm run build
```

## Package For npm

Create a package tarball:

```powershell
npm pack
```

Publish to npm:

```powershell
npm login
npm publish --access public
```

After publishing, MCP clients can run it without cloning the source:

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

Or install globally:

```powershell
npm install -g genlayer-cli-mcp
```

Then use:

```json
{
  "mcpServers": {
    "genlayer-cli": {
      "command": "genlayer-cli-mcp",
      "env": {
        "GENLAYER_PRIVATE_KEY": "0x_your_private_key_here"
      }
    }
  }
}
```

## Run

```powershell
node E:\genlayer-cli-mcp\dist\index.js
```

## MCP Client Config

Example stdio config:

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

The value may be either `0x` plus 64 hex characters or raw 64 hex characters. If the configured key is missing or invalid, `genlayer_deploy` generates a fresh private key and continues deploying with that generated key in the same tool call.

## Tools

### `check_tools`

Reports availability and versions for `node`, `genlayer`, `python`, and `genvm-lint`.

### `genlayer`

Runs `genlayer <args...>`.

Input:

```json
{
  "args": ["--version"],
  "cwd": "E:\\some-project",
  "timeoutMs": 120000,
  "env": {
    "GENLAYER_ENV": "local"
  }
}
```

### `genvm_lint`

Runs `genvm-lint <args...>`.

Input:

```json
{
  "args": ["check", "contracts\\my_contract.py", "--json"],
  "cwd": "E:\\some-project",
  "timeoutMs": 120000
}
```

### `genlayer_deploy`

Deploys an Intelligent Contract with `genlayer-js`.

Input JSON can include `privateKey`. If it is omitted, the tool uses the private key from the MCP client config. If neither value is valid, it generates a new private key with `genlayer-js` and deploys with that generated key immediately.

```json
{
  "contractPath": "contracts\\my_contract.py",
  "privateKey": "0x...",
  "args": [],
  "rpcUrl": "http://localhost:4000/api",
  "chain": "localnet",
  "autoFundLocalnet": true,
  "fundAmount": 10,
  "waitForReceipt": true,
  "receiptStatus": "ACCEPTED",
  "timeoutMs": 120000
}
```

By default the response does not include a valid configured private key. If the tool generates a new key because the configured key is invalid, the response includes that generated key so you can save it. For local development only, set `exposePrivateKey: true` if you also need a valid configured key returned:

```json
{
  "contractPath": "contracts\\my_contract.py",
  "privateKey": "invalid",
  "exposePrivateKey": true
}
```

The response includes `accountAddress`, `privateKeySource`, `transactionHash`, `contractAddress`, and optionally `receipt`.

## Security Note

This MCP server intentionally exposes full command access to both CLIs. AI agents can run state-changing commands such as `genlayer deploy`, `genlayer write`, `genlayer up`, `genlayer stop`, and `genlayer init`.
