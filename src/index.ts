#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { cwd as processCwd, env as processEnv } from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { z } from "zod";

type CommandResult = {
  command: string;
  resolvedCommand: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

const commandInputShape = {
  args: z.array(z.string()).default([]).describe("Arguments passed to the command."),
  cwd: z.string().optional().describe("Working directory for the command. Defaults to the MCP server cwd."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .default(120_000)
    .describe("Timeout in milliseconds. Defaults to 120000."),
  env: z
    .record(z.string())
    .optional()
    .describe("Extra environment variables merged over the MCP server environment.")
};

const commandInputSchema = z.object(commandInputShape);

type ResolvedCommand = {
  command: string;
  argsPrefix: string[];
};

const deployInputShape = {
  contractPath: z.string().describe("Path to the Intelligent Contract source file."),
  privateKey: z
    .string()
    .optional()
    .describe("GenLayer private key. If missing or invalid, a new private key is generated with genlayer-js."),
  args: z.array(z.unknown()).default([]).describe("Constructor arguments passed to deployContract."),
  kwargs: z.record(z.unknown()).optional().describe("Keyword constructor arguments passed to deployContract."),
  rpcUrl: z.string().url().optional().describe("Custom GenLayer RPC endpoint."),
  chain: z
    .enum(["localnet", "studionet", "testnetAsimov", "testnetBradbury"])
    .default("localnet")
    .describe("GenLayer chain used when creating the SDK client."),
  cwd: z.string().optional().describe("Base directory for resolving contractPath. Defaults to MCP server cwd."),
  leaderOnly: z.boolean().default(false),
  consensusMaxRotations: z.number().int().positive().optional(),
  initializeConsensus: z.boolean().default(true),
  autoFundLocalnet: z
    .boolean()
    .default(true)
    .describe("Call localnet sim_fundAccount before deploy. Only works on localnet."),
  fundAmount: z.number().positive().default(10),
  waitForReceipt: z.boolean().default(true),
  receiptStatus: z.enum(["ACCEPTED", "FINALIZED"]).default("ACCEPTED"),
  receiptRetries: z.number().int().positive().default(50),
  receiptIntervalMs: z.number().int().positive().default(5000),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).default(120_000),
  exposePrivateKey: z
    .boolean()
    .default(false)
    .describe("Return the generated/used private key in output. Defaults false to avoid leaking secrets.")
};

const deployInputSchema = z.object(deployInputShape);

function textResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: stringifyJson(value)
      }
    ]
  };
}

function stringifyJson(value: unknown) {
  return JSON.stringify(
    value,
    (_key, innerValue: unknown) => {
      if (typeof innerValue === "bigint") {
        return innerValue.toString();
      }

      return innerValue;
    },
    2
  );
}

async function runCommand(
  command: string,
  input: z.infer<typeof commandInputSchema>
): Promise<CommandResult> {
  const cwd = input.cwd ?? processCwd();
  const childEnv = {
    ...processEnv,
    ...(input.env ?? {})
  };

  return await new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const resolvedCommand = resolveCommand(command, childEnv);
    const child = spawn(resolvedCommand.command, [...resolvedCommand.argsPrefix, ...input.args], {
      cwd,
      env: childEnv,
      shell: false,
      windowsHide: true
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        resolvedCommand: resolvedCommand.command,
        args: input.args,
        cwd,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error: error.message
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        resolvedCommand: resolvedCommand.command,
        args: input.args,
        cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv): ResolvedCommand {
  const commandPath = process.platform === "win32" ? findWindowsCommand(command, env) : command;

  if (process.platform === "win32" && commandPath?.toLowerCase().endsWith(".cmd")) {
    const npmBin = resolveNpmBinScript(command, commandPath);
    if (npmBin) {
      return {
        command: process.execPath,
        argsPrefix: [npmBin]
      };
    }

    return {
      command: "cmd.exe",
      argsPrefix: ["/d", "/s", "/c", commandPath]
    };
  }

  return {
    command: commandPath ?? command,
    argsPrefix: []
  };
}

function findWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes("\\") || command.includes("/")) {
    return existsSync(command) ? command : undefined;
  }

  const pathValue = env.Path ?? env.PATH ?? "";
  const pathEntries = pathValue.split(delimiter).filter(Boolean);
  const extensions = [".exe", ".cmd", ".bat", ".ps1", ""];

  for (const extension of extensions) {
    for (const pathEntry of pathEntries) {
      const candidate = join(pathEntry, `${command}${extension}`);
      if (existsSync(candidate)) {
        if (isBrokenPythonScriptsLauncher(candidate)) {
          continue;
        }

        return candidate;
      }
    }
  }

  return undefined;
}

function isBrokenPythonScriptsLauncher(candidate: string): boolean {
  if (!candidate.toLowerCase().endsWith(".exe")) {
    return false;
  }

  const scriptsDirectory = dirname(candidate);
  if (scriptsDirectory.toLowerCase().split(/[\\/]/).at(-1) !== "scripts") {
    return false;
  }

  return !existsSync(join(dirname(scriptsDirectory), "python.exe"));
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const RAW_PRIVATE_KEY_RE = /^[0-9a-fA-F]{64}$/;

const chains = {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury
};

async function deployWithSdk(input: z.infer<typeof deployInputSchema>) {
  const baseCwd = input.cwd ?? processCwd();
  const contractPath = resolve(baseCwd, input.contractPath);

  if (!existsSync(contractPath)) {
    throw new Error(`Contract file not found: ${contractPath}`);
  }

  const configuredPrivateKey = getConfiguredPrivateKey();
  const selectedPrivateKey = input.privateKey ?? configuredPrivateKey.value;
  const normalizedPrivateKey = normalizePrivateKey(selectedPrivateKey);
  const providedPrivateKeyValid = Boolean(normalizedPrivateKey);
  const generatedPrivateKey = !providedPrivateKeyValid;
  const privateKey = (normalizedPrivateKey ?? generatePrivateKey()) as `0x${string}`;
  const account = createAccount(privateKey);
  const contractCode = readFileSync(contractPath, "utf8");

  if (!contractCode.trim()) {
    throw new Error(`Contract file is empty: ${contractPath}`);
  }

  const client = createClient({
    chain: chains[input.chain],
    endpoint: input.rpcUrl,
    account
  });

  const deployOperation = async () => {
    if (input.initializeConsensus) {
      await client.initializeConsensusSmartContract();
    }

    let funded = false;
    let fundingError: string | undefined;
    if (input.autoFundLocalnet && input.chain === "localnet") {
      try {
        await (client as unknown as { fundAccount(args: { address: string; amount: number }): Promise<unknown> })
          .fundAccount({
            address: account.address,
            amount: input.fundAmount
          });
        funded = true;
      } catch (error) {
        fundingError = error instanceof Error ? error.message : String(error);
      }
    }

    const transactionHash = await client.deployContract({
      account,
      code: contractCode,
      args: input.args as Parameters<typeof client.deployContract>[0]["args"],
      kwargs: input.kwargs as Parameters<typeof client.deployContract>[0]["kwargs"],
      leaderOnly: input.leaderOnly,
      consensusMaxRotations: input.consensusMaxRotations
    });

    const receipt = input.waitForReceipt
      ? await client.waitForTransactionReceipt({
          hash: transactionHash as Parameters<typeof client.waitForTransactionReceipt>[0]["hash"],
          status:
            input.receiptStatus === "FINALIZED"
              ? TransactionStatus.FINALIZED
              : TransactionStatus.ACCEPTED,
          retries: input.receiptRetries,
          interval: input.receiptIntervalMs
        })
      : undefined;

    const contractAddress =
      (receipt as { data?: { contract_address?: unknown }; txDataDecoded?: { contractAddress?: unknown } } | undefined)
        ?.data?.contract_address ??
      (receipt as { txDataDecoded?: { contractAddress?: unknown } } | undefined)?.txDataDecoded
        ?.contractAddress;

    return {
      ok: true,
      contractPath,
      chain: input.chain,
      rpcUrl: input.rpcUrl,
      accountAddress: account.address,
      privateKeySource: providedPrivateKeyValid
        ? input.privateKey
          ? "input"
          : configuredPrivateKey.source
        : "generated",
      privateKey: generatedPrivateKey || input.exposePrivateKey ? privateKey : undefined,
      privateKeyExposed: generatedPrivateKey || input.exposePrivateKey,
      deployAttempted: true,
      funded,
      fundingError,
      transactionHash,
      contractAddress,
      receipt
    };
  };

  return await withTimeout(deployOperation(), input.timeoutMs);
}

function getConfiguredPrivateKey(): { value?: string; source?: string } {
  const candidates = [
    ["GENLAYER_PRIVATE_KEY", processEnv.GENLAYER_PRIVATE_KEY],
    ["GENLAYER_PRV_KEY", processEnv.GENLAYER_PRV_KEY],
    ["GENLAYER_PRIVKEY", processEnv.GENLAYER_PRIVKEY],
    ["PRIVATE_KEY", processEnv.PRIVATE_KEY]
  ] as const;

  const match = candidates.find(([_name, value]) => Boolean(value));
  return {
    value: match?.[1],
    source: match?.[0]
  };
}

function normalizePrivateKey(privateKey: string | undefined): `0x${string}` | undefined {
  if (!privateKey) {
    return undefined;
  }

  const trimmed = privateKey.trim();
  if (PRIVATE_KEY_RE.test(trimmed)) {
    return trimmed as `0x${string}`;
  }

  if (RAW_PRIVATE_KEY_RE.test(trimmed)) {
    return `0x${trimmed}`;
  }

  return undefined;
}

function getPrivateKeyConfigStatus() {
  const configuredPrivateKey = getConfiguredPrivateKey();
  const normalizedPrivateKey = normalizePrivateKey(configuredPrivateKey.value);

  return {
    source: configuredPrivateKey.source,
    configured: Boolean(configuredPrivateKey.value),
    valid: Boolean(normalizedPrivateKey),
    willGenerateOnDeploy: !normalizedPrivateKey,
    note: normalizedPrivateKey
      ? "genlayer_deploy will use the configured private key."
      : "genlayer_deploy will generate a new private key and deploy with it."
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function safeDeployWithSdk(input: z.infer<typeof deployInputSchema>) {
  try {
    return await deployWithSdk(input);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolveNpmBinScript(command: string, commandPath: string): string | undefined {
  const packageJsonPath = join(dirname(commandPath), "node_modules", command, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const binPath =
      typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[command];

    return binPath ? resolve(dirname(packageJsonPath), binPath) : undefined;
  } catch {
    return undefined;
  }
}

async function checkCommand(command: string, args: string[] = ["--version"]) {
  const result = await runCommand(command, {
    args,
    timeoutMs: 15_000
  });
  const error =
    result.error ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    (result.exitCode === null ? "Command could not be started" : `Command failed with exit code ${result.exitCode}`);

  return {
    command,
    resolvedCommand: result.resolvedCommand,
    available: result.exitCode === 0,
    version: result.exitCode === 0 ? result.stdout.trim() || result.stderr.trim() : null,
    error: result.exitCode === 0 ? undefined : error,
    exitCode: result.exitCode
  };
}

const server = new McpServer({
  name: "genlayer-cli-mcp",
  version: "0.1.0"
});

server.tool(
  "genlayer",
  "Run the GenLayer CLI with full command access. This can perform state-changing operations.",
  commandInputShape,
  async (input) => textResponse(await runCommand("genlayer", input))
);

server.tool(
  "genvm_lint",
  "Run genvm-lint for GenVM contract linting, validation, schema extraction, typechecking, setup, or downloads.",
  commandInputShape,
  async (input) => textResponse(await runCommand("genvm-lint", input))
);

server.tool(
  "genlayer_deploy",
  "Deploy a GenLayer Intelligent Contract with genlayer-js. Accepts privateKey; generates one when missing or invalid.",
  deployInputShape,
  async (input) => textResponse(await safeDeployWithSdk(input))
);

server.tool(
  "check_tools",
  "Check whether node, genlayer, python, and genvm-lint are available to this MCP server.",
  {},
  async () => {
    const checks = await Promise.all([
      checkCommand("node"),
      checkCommand("genlayer"),
      checkCommand("python"),
      checkCommand("genvm-lint")
    ]);

    return textResponse({
      cwd: processCwd(),
      privateKeyConfig: getPrivateKeyConfigStatus(),
      checks
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
