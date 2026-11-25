#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { cwd as processCwd, env as processEnv } from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAccount, createClient, generatePrivateKey, isSuccessful } from "genlayer-js";
import { localnet, studioDevnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import { CalldataAddress } from "genlayer-js/types";
import type { CalldataEncodable } from "genlayer-js/types";
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

const CALLDATA_HINT =
  'JSON values map to calldata; use string prefixes for other types: "addr#<40 hex>" for an address, "b#<hex>" for bytes, "int#<digits>" for integers beyond 2^53.';

const chainNames = ["localnet", "studionet", "studioDevnet", "testnetAsimov", "testnetBradbury"] as const;

const deployInputShape = {
  contractPath: z.string().describe("Path to the Intelligent Contract source file."),
  privateKey: z
    .string()
    .optional()
    .describe("GenLayer private key. If missing or invalid, a new private key is generated with genlayer-js."),
  args: z
    .array(z.unknown())
    .default([])
    .describe(`Constructor arguments passed to deployContract. ${CALLDATA_HINT}`),
  kwargs: z.record(z.unknown()).optional().describe("Keyword constructor arguments passed to deployContract."),
  rpcUrl: z.string().url().optional().describe("Custom GenLayer RPC endpoint."),
  chain: z
    .enum(chainNames)
    .default("localnet")
    .describe("GenLayer chain used when creating the SDK client."),
  cwd: z.string().optional().describe("Base directory for resolving contractPath. Defaults to MCP server cwd."),
  leaderOnly: z.boolean().default(false),
  consensusMaxRotations: z.number().int().positive().optional(),
  initializeConsensus: z
    .boolean()
    .default(false)
    .describe("Deprecated and ignored: genlayer-js 2.x resolves the consensus contract from the chain definition."),
  fees: z
    .record(z.unknown())
    .optional()
    .describe(
      "genlayer-js transaction fee options ({ distribution, messageAllocations, feeValue }). Skips automatic estimation when set."
    ),
  autoEstimateFees: z
    .boolean()
    .default(true)
    .describe("Estimate fees with genlayer-js when the chain's fee policy is enabled and fees is not provided."),
  autoFundLocalnet: z
    .boolean()
    .default(true)
    .describe("Call localnet sim_fundAccount before deploy. Only works on localnet."),
  fundAmount: z.number().positive().default(10),
  waitForReceipt: z.boolean().default(true),
  receiptStatus: z
    .enum(["ACCEPTED", "FINALIZED"])
    .default("ACCEPTED")
    .describe(
      "ACCEPTED waits until consensus decides the transaction (accepted, undetermined, or timeout); FINALIZED waits for finalization."
    ),
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

      if (innerValue instanceof Map) {
        return Object.fromEntries(innerValue);
      }

      if (innerValue instanceof Uint8Array) {
        return `0x${Buffer.from(innerValue).toString("hex")}`;
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
  studioDevnet,
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

    const { fees, feeSource, feeEstimateError } = await resolveFees(input, () => client.estimateTransactionFees());

    const transactionHash = await client.deployContract({
      account,
      code: contractCode,
      args: toCalldataArgs(input.args),
      kwargs: toCalldataKwargs(input.kwargs),
      leaderOnly: input.leaderOnly,
      consensusMaxRotations: input.consensusMaxRotations,
      fees
    });

    const receipt = input.waitForReceipt
      ? await client.waitForTransactionReceipt({
          hash: transactionHash as Parameters<typeof client.waitForTransactionReceipt>[0]["hash"],
          waitUntil: input.receiptStatus === "FINALIZED" ? "finalized" : "decided",
          retries: input.receiptRetries,
          interval: input.receiptIntervalMs
        })
      : undefined;

    const contractAddress =
      (receipt as { data?: { contract_address?: unknown }; txDataDecoded?: { contractAddress?: unknown } } | undefined)
        ?.data?.contract_address ??
      (receipt as { txDataDecoded?: { contractAddress?: unknown } } | undefined)?.txDataDecoded
        ?.contractAddress;

    // "decided" also covers UNDETERMINED and timeout outcomes, so success needs
    // consensus acceptance plus a clean execution result.
    const succeeded = receipt ? isSuccessful(receipt) : true;

    return {
      ok: succeeded,
      error: succeeded
        ? undefined
        : `Deploy transaction was not accepted: status=${receipt?.statusName ?? "unknown"}, executionResult=${receipt?.txExecutionResultName ?? "unknown"}`,
      transactionStatus: receipt?.statusName ?? receipt?.status,
      executionResult: receipt?.txExecutionResultName,
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
      feeSource,
      feeValue: fees?.feeValue,
      feeEstimateError,
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

type GenLayerSdkClient = ReturnType<typeof createClient>;
type SdkFees = Parameters<GenLayerSdkClient["deployContract"]>[0]["fees"];
type Address = `0x${string}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const addressSchema = z.string().regex(ADDRESS_RE, "Expected a 0x-prefixed 20-byte address.");
const hashSchema = z.string().regex(HASH_RE, "Expected a 0x-prefixed 32-byte transaction hash.");

const connectionShape = {
  chain: z.enum(chainNames).default("localnet").describe("GenLayer chain used when creating the SDK client."),
  rpcUrl: z.string().url().optional().describe("Custom GenLayer RPC endpoint."),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).default(120_000)
};

const signerShape = {
  privateKey: z
    .string()
    .optional()
    .describe("Private key used to sign. Defaults to GENLAYER_PRIVATE_KEY from the MCP server environment.")
};

const callShape = {
  contractAddress: addressSchema.describe("Deployed Intelligent Contract address."),
  method: z.string().min(1).describe("Contract method name."),
  args: z.array(z.unknown()).default([]).describe(`Positional method arguments. ${CALLDATA_HINT}`),
  kwargs: z.record(z.unknown()).optional().describe("Keyword method arguments.")
};

const feeShape = {
  fees: z
    .record(z.unknown())
    .optional()
    .describe(
      "genlayer-js transaction fee options ({ distribution, messageAllocations, feeValue }). Skips automatic estimation when set."
    ),
  autoEstimateFees: z
    .boolean()
    .default(true)
    .describe("Estimate fees with genlayer-js when the chain's fee policy is enabled and fees is not provided.")
};

const receiptShape = {
  waitForReceipt: z.boolean().default(true),
  receiptStatus: z
    .enum(["ACCEPTED", "FINALIZED"])
    .default("ACCEPTED")
    .describe(
      "ACCEPTED waits until consensus decides the transaction (accepted, undetermined, or timeout); FINALIZED waits for finalization."
    ),
  receiptRetries: z.number().int().positive().default(50),
  receiptIntervalMs: z.number().int().positive().default(5000)
};

const weiSchema = z
  .string()
  .regex(/^\d+$/, "Expected a non-negative integer string in wei.")
  .optional();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCalldata(value: unknown): CalldataEncodable {
  if (typeof value === "string") {
    const address = /^addr#([0-9a-fA-F]{40})$/.exec(value);
    if (address) {
      return new CalldataAddress(Uint8Array.from(Buffer.from(address[1], "hex")));
    }

    const bytes = /^b#((?:[0-9a-fA-F]{2})*)$/.exec(value);
    if (bytes) {
      return Uint8Array.from(Buffer.from(bytes[1], "hex"));
    }

    const integer = /^int#(-?\d+)$/.exec(value);
    if (integer) {
      return BigInt(integer[1]);
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toCalldata);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toCalldata(inner)]));
  }

  if (value === undefined) {
    return null;
  }

  return value as CalldataEncodable;
}

function toCalldataArgs(args: unknown[]): CalldataEncodable[] {
  return args.map(toCalldata);
}

function toCalldataKwargs(kwargs: Record<string, unknown> | undefined) {
  return kwargs ? (toCalldata(kwargs) as { [key: string]: CalldataEncodable }) : undefined;
}

type FeeEstimate = Awaited<ReturnType<GenLayerSdkClient["estimateTransactionFees"]>>;

async function resolveFees(
  input: { fees?: Record<string, unknown>; autoEstimateFees: boolean },
  estimate: () => Promise<FeeEstimate>
): Promise<{ fees: SdkFees; feeSource: "input" | "estimated" | "none"; feeEstimateError?: string }> {
  if (input.fees) {
    return { fees: input.fees as SdkFees, feeSource: "input" };
  }

  if (!input.autoEstimateFees) {
    return { fees: undefined, feeSource: "none" };
  }

  try {
    const result = await estimate();
    if (!result.policy.enabled) {
      return { fees: undefined, feeSource: "none" };
    }

    return {
      fees: {
        distribution: result.distribution,
        messageAllocations: result.messageAllocations,
        feeValue: result.feeValue
      },
      feeSource: "estimated"
    };
  } catch (error) {
    return { fees: undefined, feeSource: "none", feeEstimateError: errorMessage(error) };
  }
}

function makeClient(
  input: { chain: (typeof chainNames)[number]; rpcUrl?: string; privateKey?: string },
  mode: "read" | "sign"
) {
  const configuredPrivateKey = getConfiguredPrivateKey();
  const privateKey = normalizePrivateKey(input.privateKey ?? configuredPrivateKey.value);

  if (!privateKey && mode === "sign") {
    throw new Error(
      "A valid private key is required: pass privateKey or set GENLAYER_PRIVATE_KEY in the MCP server environment."
    );
  }

  // Read-only calls still need a sender address; an ephemeral one is enough.
  const account = createAccount(privateKey ?? generatePrivateKey());
  const client = createClient({
    chain: chains[input.chain],
    endpoint: input.rpcUrl,
    account
  });

  return {
    client,
    account,
    privateKeySource: privateKey ? (input.privateKey ? "input" : configuredPrivateKey.source) : "ephemeral"
  };
}

async function safeOperation<T extends object>(timeoutMs: number, operation: () => Promise<T>) {
  try {
    return await withTimeout(operation(), timeoutMs);
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error)
    };
  }
}

function describeNetworks() {
  return Object.entries(chains).map(([name, chain]) => ({
    name,
    chainId: chain.id,
    displayName: chain.name,
    isStudio: chain.isStudio,
    rpcUrl: chain.rpcUrls.default.http[0],
    explorerUrl: chain.blockExplorers?.default?.url,
    nativeCurrency: chain.nativeCurrency.symbol,
    defaultNumberOfInitialValidators: chain.defaultNumberOfInitialValidators,
    defaultConsensusMaxRotations: chain.defaultConsensusMaxRotations,
    contracts: {
      consensusMain: chain.consensusMainContract?.address,
      consensusData: chain.consensusDataContract?.address,
      staking: chain.stakingContract?.address,
      feeManager: chain.feeManagerContract?.address,
      appeals: chain.appealsContract?.address
    }
  }));
}

const estimateFeesShape = {
  ...connectionShape,
  contractAddress: addressSchema
    .optional()
    .describe("With method: estimate for this specific write using a simulation (Studio and localnet only)."),
  method: z.string().min(1).optional(),
  args: callShape.args,
  kwargs: callShape.kwargs,
  feeOptions: z
    .record(z.unknown())
    .optional()
    .describe(
      "genlayer-js fee estimate options, e.g. { appealRounds, leaderTimeunitsAllocation, validatorTimeunitsAllocation, priceCapHeadroomBps }."
    )
};

async function estimateFees(input: z.infer<z.ZodObject<typeof estimateFeesShape>>) {
  const { client } = makeClient(input, "read");
  const options = (input.feeOptions ?? {}) as NonNullable<Parameters<typeof client.estimateTransactionFees>[0]>;
  const targeted = Boolean(input.contractAddress && input.method);

  const estimate = targeted
    ? await client.estimateTransactionFeesForWrite({
        ...options,
        address: input.contractAddress as Address,
        functionName: input.method as string,
        args: toCalldataArgs(input.args),
        kwargs: toCalldataKwargs(input.kwargs)
      })
    : await client.estimateTransactionFees(options);

  return {
    ok: true,
    chain: input.chain,
    estimateType: targeted ? "write-simulation" : "default",
    feePolicyEnabled: estimate.policy.enabled,
    feeValue: estimate.feeValue,
    fees: {
      distribution: estimate.distribution,
      messageAllocations: estimate.messageAllocations,
      feeValue: estimate.feeValue
    },
    policy: estimate.policy,
    observed: estimate.observed
  };
}

const callInputShape = {
  ...connectionShape,
  ...callShape
};

async function callContract(input: z.infer<z.ZodObject<typeof callInputShape>>) {
  const { client } = makeClient(input, "read");
  const result = await client.readContract({
    address: input.contractAddress as Address,
    functionName: input.method,
    args: toCalldataArgs(input.args),
    kwargs: toCalldataKwargs(input.kwargs),
    jsonSafeReturn: true
  });

  return {
    ok: true,
    chain: input.chain,
    contractAddress: input.contractAddress,
    method: input.method,
    result
  };
}

const writeInputShape = {
  ...connectionShape,
  ...signerShape,
  ...callShape,
  value: weiSchema.describe("Native value sent with the call, in wei."),
  leaderOnly: z.boolean().default(false),
  consensusMaxRotations: z.number().int().positive().optional(),
  ...feeShape,
  ...receiptShape
};

async function writeContract(input: z.infer<z.ZodObject<typeof writeInputShape>>) {
  const { client, account, privateKeySource } = makeClient(input, "sign");
  const call = {
    address: input.contractAddress as Address,
    functionName: input.method,
    args: toCalldataArgs(input.args),
    kwargs: toCalldataKwargs(input.kwargs),
    value: input.value === undefined ? undefined : BigInt(input.value),
    leaderOnly: input.leaderOnly
  };

  const { fees, feeSource, feeEstimateError } = await resolveFees(input, async () => {
    try {
      // Simulation-based sizing only exists on Studio and localnet.
      return await client.estimateTransactionFeesForWrite(call);
    } catch {
      return await client.estimateTransactionFees();
    }
  });

  const transactionHash = (await client.writeContract({
    ...call,
    account,
    consensusMaxRotations: input.consensusMaxRotations,
    fees
  })) as Address;

  const receipt = input.waitForReceipt
    ? await client.waitForTransactionReceipt({
        hash: transactionHash as Parameters<typeof client.waitForTransactionReceipt>[0]["hash"],
        waitUntil: input.receiptStatus === "FINALIZED" ? "finalized" : "decided",
        retries: input.receiptRetries,
        interval: input.receiptIntervalMs
      })
    : undefined;

  const succeeded = receipt ? isSuccessful(receipt) : true;

  return {
    ok: succeeded,
    error: succeeded
      ? undefined
      : `Transaction was not accepted: status=${receipt?.statusName ?? "unknown"}, executionResult=${receipt?.txExecutionResultName ?? "unknown"}`,
    chain: input.chain,
    contractAddress: input.contractAddress,
    method: input.method,
    accountAddress: account.address,
    privateKeySource,
    feeSource,
    feeValue: fees?.feeValue,
    feeEstimateError,
    transactionHash,
    transactionStatus: receipt?.statusName ?? receipt?.status,
    executionResult: receipt?.txExecutionResultName,
    receipt
  };
}

const transactionSections = ["lifecycle", "trace", "appeal", "triggered", "queue"] as const;

const transactionInputShape = {
  ...connectionShape,
  hash: hashSchema.describe("GenLayer transaction hash."),
  include: z
    .array(z.enum(transactionSections))
    .default(["lifecycle"])
    .describe(
      "Extra sections: lifecycle (protocol phase and resolution action), trace (return data, stdout, stderr, GenVM logs), appeal (canAppeal and appeal charge), triggered (child transaction ids), queue (queue position)."
    ),
  traceRound: z.number().int().nonnegative().default(0).describe("Consensus round used for the trace section.")
};

async function inspectTransaction(input: z.infer<z.ZodObject<typeof transactionInputShape>>) {
  const { client } = makeClient(input, "read");
  const hash = input.hash as Parameters<typeof client.getTransaction>[0]["hash"];
  const transaction = await client.getTransaction({ hash });

  const sections: Record<string, unknown> = {};
  const readers: Record<(typeof transactionSections)[number], () => Promise<unknown>> = {
    lifecycle: () => client.advanced.getTransactionLifecycle({ hash }),
    trace: () => client.debugTraceTransaction({ hash, round: input.traceRound }),
    appeal: async () => ({
      canAppeal: await client.canAppeal({ txId: hash }),
      appealCharge: await client.getAppealCharge({ txId: hash })
    }),
    triggered: () => client.getTriggeredTransactionIds({ hash }),
    queue: () => client.getTransactionQueuePosition({ hash })
  };

  // Sections are independent: one unsupported RPC must not hide the others.
  await Promise.all(
    [...new Set(input.include)].map(async (section) => {
      try {
        sections[section] = await readers[section]();
      } catch (error) {
        sections[section] = { error: errorMessage(error) };
      }
    })
  );

  return {
    ok: true,
    chain: input.chain,
    hash: input.hash,
    transactionStatus: transaction.statusName,
    executionResult: transaction.txExecutionResultName,
    successful: isSuccessful(transaction),
    ...sections,
    transaction
  };
}

const contractInfoShape = {
  ...connectionShape,
  contractAddress: addressSchema.optional().describe("Deployed contract to inspect."),
  contractPath: z
    .string()
    .optional()
    .describe("Local contract source file; returns its schema without deploying (Studio and localnet only)."),
  cwd: z.string().optional().describe("Base directory for resolving contractPath. Defaults to MCP server cwd."),
  includeCode: z.boolean().default(false).describe("Also return the deployed contract source.")
};

async function contractInfo(input: z.infer<z.ZodObject<typeof contractInfoShape>>) {
  if (Boolean(input.contractAddress) === Boolean(input.contractPath)) {
    throw new Error("Provide exactly one of contractAddress or contractPath.");
  }

  const { client } = makeClient(input, "read");

  if (input.contractPath) {
    const contractPath = resolve(input.cwd ?? processCwd(), input.contractPath);
    if (!existsSync(contractPath)) {
      throw new Error(`Contract file not found: ${contractPath}`);
    }

    return {
      ok: true,
      chain: input.chain,
      contractPath,
      schema: await client.getContractSchemaForCode(readFileSync(contractPath, "utf8"))
    };
  }

  const address = input.contractAddress as Address;
  return {
    ok: true,
    chain: input.chain,
    contractAddress: address,
    schema: await client.getContractSchema(address),
    code: input.includeCode ? await client.getContractCode(address) : undefined
  };
}

const transactionActionShape = {
  ...connectionShape,
  ...signerShape,
  hash: hashSchema.describe("GenLayer transaction hash."),
  action: z
    .enum(["appeal", "finalize", "cancel"])
    .describe(
      "appeal: submit an appeal (pays the appeal charge). finalize: finalize a transaction that is ready. cancel: cancel a pending transaction (Studio and localnet only)."
    ),
  value: weiSchema.describe("Appeal only: value in wei. Defaults to the SDK-computed appeal charge.")
};

async function transactionAction(input: z.infer<z.ZodObject<typeof transactionActionShape>>) {
  const { client, account, privateKeySource } = makeClient(input, "sign");
  const txId = input.hash as Address;

  let result: unknown;
  if (input.action === "appeal") {
    result = await client.appealTransaction({
      account,
      txId,
      value: input.value === undefined ? undefined : BigInt(input.value)
    });
  } else if (input.action === "finalize") {
    result = await client.finalizeTransaction({ account, txId });
  } else {
    result = await client.cancelTransaction({
      hash: txId as Parameters<typeof client.cancelTransaction>[0]["hash"]
    });
  }

  return {
    ok: true,
    chain: input.chain,
    action: input.action,
    hash: input.hash,
    accountAddress: account.address,
    privateKeySource,
    result
  };
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
  version: "0.3.0"
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

server.tool(
  "genlayer_networks",
  "List the GenLayer networks built into genlayer-js with chain id, RPC URL, explorer, and protocol contract addresses.",
  {},
  async () => textResponse({ networks: describeNetworks() })
);

server.tool(
  "genlayer_estimate_fees",
  "Estimate GenLayer transaction fees (read-only). Returns a fees object that can be passed to genlayer_deploy or genlayer_write. Pass contractAddress and method to size the estimate from a write simulation.",
  estimateFeesShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => estimateFees(input)))
);

server.tool(
  "genlayer_call",
  "Call a read-only method on a deployed Intelligent Contract with genlayer-js. Does not send a transaction.",
  callInputShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => callContract(input)))
);

server.tool(
  "genlayer_write",
  "Send a state-changing transaction to an Intelligent Contract method with genlayer-js. Estimates fees automatically and reports ok only when consensus accepted the transaction.",
  writeInputShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => writeContract(input)))
);

server.tool(
  "genlayer_transaction",
  "Inspect a GenLayer transaction (read-only): status, execution result, and optional lifecycle, execution trace, appeal info, triggered transactions, and queue position.",
  transactionInputShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => inspectTransaction(input)))
);

server.tool(
  "genlayer_contract_info",
  "Get the schema (methods and parameters) of a deployed Intelligent Contract or a local contract file, optionally with the deployed source (read-only).",
  contractInfoShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => contractInfo(input)))
);

server.tool(
  "genlayer_transaction_action",
  "Appeal, finalize, or cancel a GenLayer transaction. State-changing: signs with the configured private key and may spend funds.",
  transactionActionShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => transactionAction(input)))
);

const transport = new StdioServerTransport();
await server.connect(transport);
