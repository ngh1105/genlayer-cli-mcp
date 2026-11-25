#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { cwd as processCwd, env as processEnv } from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAccount, createClient, generatePrivateKey, isSuccessful } from "genlayer-js";
import { localnet, studioDevnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import { CalldataAddress, transactionsStatusNumberToName } from "genlayer-js/types";
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
    .describe(
      "GenLayer private key. When no key, keystore account, or environment key resolves, a new private key is generated."
    ),
  account: z
    .string()
    .optional()
    .describe("GenLayer CLI keystore account name to sign with. The account must be unlocked."),
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
    .describe(
      "Fund the deploying account with the sim_fundAccount faucet before deploy: always on localnet, and on Studio networks when the key was generated."
    ),
  fundAmount: z.number().positive().default(10).describe("Faucet amount in GEN."),
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

  // An invalid privateKey input keeps its documented meaning: deploy with a fresh key.
  const signer: Signer =
    input.privateKey !== undefined && !normalizePrivateKey(input.privateKey) ? {} : await resolveSigner(input);
  const generatedPrivateKey = !signer.privateKey;
  const privateKey = signer.privateKey ?? generatePrivateKey();
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
    // A generated key starts empty, so it also needs the faucet on hosted Studio networks.
    const shouldFund =
      input.autoFundLocalnet &&
      (input.chain === "localnet" || (generatedPrivateKey && chains[input.chain].isStudio));
    if (shouldFund) {
      try {
        // sim_fundAccount takes wei; round to gwei to stay exact for fractional GEN.
        const wei = BigInt(Math.round(input.fundAmount * 1e9)) * 10n ** 9n;
        await (client as unknown as { request(args: { method: string; params: unknown[] }): Promise<unknown> }).request({
          method: "sim_fundAccount",
          params: [account.address, Number(wei)]
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
        : `Deploy transaction was not accepted: status=${statusNameOf(receipt) ?? "unknown"}, executionResult=${receipt?.txExecutionResultName ?? "unknown"}`,
      transactionStatus: statusNameOf(receipt),
      executionResult: receipt?.txExecutionResultName,
      contractPath,
      chain: input.chain,
      rpcUrl: input.rpcUrl,
      accountAddress: account.address,
      privateKeySource: signer.source ?? "generated",
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
    .describe(
      "Private key used to sign. Defaults to GENLAYER_PRIVATE_KEY, then the active unlocked GenLayer CLI keystore account."
    ),
  account: z
    .string()
    .optional()
    .describe("GenLayer CLI keystore account name to sign with (see genlayer_account). The account must be unlocked.")
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

// Studio receipts carry only the numeric status; contract networks also set statusName.
function statusNameOf(transaction: { statusName?: string; status?: unknown } | undefined): string | undefined {
  if (!transaction) {
    return undefined;
  }

  const names = transactionsStatusNumberToName as Record<string, string>;
  return (
    transaction.statusName ??
    names[String(transaction.status)] ??
    (transaction.status === undefined ? undefined : String(transaction.status))
  );
}

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

async function makeClient(
  input: { chain: (typeof chainNames)[number]; rpcUrl?: string; privateKey?: string; account?: string },
  mode: "read" | "sign"
) {
  const signer = await resolveSigner(input);

  if (!signer.privateKey && mode === "sign") {
    throw new Error(
      "No signer available: pass privateKey or account, set GENLAYER_PRIVATE_KEY, or unlock the active GenLayer CLI account (genlayer account unlock)."
    );
  }

  // Read-only calls still need a sender address; an ephemeral one is enough.
  const account = createAccount(signer.privateKey ?? generatePrivateKey());
  const client = createClient({
    chain: chains[input.chain],
    endpoint: input.rpcUrl,
    account
  });

  return {
    client,
    account,
    privateKeySource: signer.source ?? "ephemeral"
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
  const { client } = await makeClient(input, "read");
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
  const { client } = await makeClient(input, "read");
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
  const { client, account, privateKeySource } = await makeClient(input, "sign");
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
      : `Transaction was not accepted: status=${statusNameOf(receipt) ?? "unknown"}, executionResult=${receipt?.txExecutionResultName ?? "unknown"}`,
    chain: input.chain,
    contractAddress: input.contractAddress,
    method: input.method,
    accountAddress: account.address,
    privateKeySource,
    feeSource,
    feeValue: fees?.feeValue,
    feeEstimateError,
    transactionHash,
    transactionStatus: statusNameOf(receipt),
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
  const { client } = await makeClient(input, "read");
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
    transactionStatus: statusNameOf(transaction),
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

  const { client } = await makeClient(input, "read");

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
    .enum(["appeal", "finalize", "cancel", "topUpFees", "topUpAndAppeal"])
    .describe(
      "appeal: submit an appeal (pays the appeal charge). finalize: finalize a transaction that is ready. cancel: cancel a pending transaction (Studio and localnet only). topUpFees: add fee budget to a transaction. topUpAndAppeal: add fee budget and appeal in one transaction."
    ),
  value: weiSchema.describe(
    "Value in wei. appeal: defaults to the SDK-computed appeal charge. topUpFees: defaults to the estimated fee value."
  ),
  feeOptions: z
    .record(z.unknown())
    .optional()
    .describe("topUpFees / topUpAndAppeal: fee estimate options used to build the fee distribution, e.g. { appealRounds }.")
};

async function transactionAction(input: z.infer<z.ZodObject<typeof transactionActionShape>>) {
  const { client, account, privateKeySource } = await makeClient(input, "sign");
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
  } else if (input.action === "topUpFees" || input.action === "topUpAndAppeal") {
    const estimate = await client.estimateTransactionFees(
      (input.feeOptions ?? {}) as NonNullable<Parameters<typeof client.estimateTransactionFees>[0]>
    );
    const value = input.value === undefined ? undefined : BigInt(input.value);
    result =
      input.action === "topUpFees"
        ? await client.topUpFees({
            account,
            txId,
            distribution: estimate.distribution,
            value: value ?? estimate.feeValue
          })
        : await client.topUpAndSubmitAppeal({ account, txId, distribution: estimate.distribution, value });
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

const GENLAYER_HOME = join(homedir(), ".genlayer");
const KEYCHAIN_SERVICE = "genlayer-cli";

type KeystoreAccount = { name: string; address?: string };

function listKeystoreAccounts(): KeystoreAccount[] {
  const directory = join(GENLAYER_HOME, "keystores");
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const name = file.slice(0, -".json".length);
      try {
        const keystore = JSON.parse(readFileSync(join(directory, file), "utf8")) as { address?: string };
        const address = keystore.address
          ? keystore.address.startsWith("0x")
            ? keystore.address
            : `0x${keystore.address}`
          : undefined;
        return { name, address };
      } catch {
        return { name };
      }
    });
}

function getActiveKeystoreAccount(): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(GENLAYER_HOME, "genlayer-config.json"), "utf8")) as {
      activeAccount?: string;
    };
    return config.activeAccount;
  } catch {
    return undefined;
  }
}

type Keytar = { getPassword(service: string, account: string): Promise<string | null> };

let keytarPromise: Promise<Keytar | undefined> | undefined;

// keytar is an optional native dependency; without it the keystore fallback is simply unavailable.
function loadKeytar(): Promise<Keytar | undefined> {
  keytarPromise ??= import("keytar")
    .then((module) => ((module as { default?: Keytar }).default ?? module) as Keytar)
    .catch(() => undefined);
  return keytarPromise;
}

async function readUnlockedKey(accountName: string): Promise<`0x${string}` | undefined> {
  const keytar = await loadKeytar();
  if (!keytar) {
    return undefined;
  }

  try {
    return normalizePrivateKey((await keytar.getPassword(KEYCHAIN_SERVICE, `account:${accountName}`)) ?? undefined);
  } catch {
    return undefined;
  }
}

async function readKeystorePrivateKey(accountName: string): Promise<`0x${string}`> {
  const accounts = listKeystoreAccounts();
  const entry = accounts.find((account) => account.name === accountName);
  if (!entry) {
    const available = accounts.map((account) => account.name).join(", ") || "none";
    throw new Error(`Account "${accountName}" not found in the GenLayer CLI keystore. Available: ${available}.`);
  }

  if (!(await loadKeytar())) {
    throw new Error("OS keychain support (optional dependency keytar) is not available to this MCP server.");
  }

  const privateKey = await readUnlockedKey(accountName);
  if (!privateKey) {
    throw new Error(`Account "${accountName}" is locked. Run: genlayer account unlock --account ${accountName}`);
  }

  if (entry.address && createAccount(privateKey).address.toLowerCase() !== entry.address.toLowerCase()) {
    throw new Error(`Keychain entry for "${accountName}" does not match the keystore address ${entry.address}.`);
  }

  return privateKey;
}

type Signer = { privateKey?: `0x${string}`; source?: string };

// Precedence: explicit privateKey, explicit keystore account, environment, active unlocked keystore account.
async function resolveSigner(input: { privateKey?: string; account?: string }): Promise<Signer> {
  if (input.privateKey !== undefined) {
    const privateKey = normalizePrivateKey(input.privateKey);
    if (!privateKey) {
      throw new Error("privateKey is not a valid 32-byte hex private key.");
    }

    return { privateKey, source: "input" };
  }

  if (input.account) {
    return { privateKey: await readKeystorePrivateKey(input.account), source: `keystore:${input.account}` };
  }

  const configured = getConfiguredPrivateKey();
  const environmentKey = normalizePrivateKey(configured.value);
  if (environmentKey) {
    return { privateKey: environmentKey, source: configured.source };
  }

  const activeAccount = getActiveKeystoreAccount();
  if (activeAccount) {
    const privateKey = await readUnlockedKey(activeAccount);
    if (privateKey) {
      return { privateKey, source: `keystore:${activeAccount}` };
    }
  }

  return {};
}

async function getPrivateKeyConfigStatus() {
  const configuredPrivateKey = getConfiguredPrivateKey();
  const environmentValid = Boolean(normalizePrivateKey(configuredPrivateKey.value));
  const activeAccount = getActiveKeystoreAccount();
  const keychainAvailable = Boolean(await loadKeytar());
  const accounts = await Promise.all(
    listKeystoreAccounts().map(async (account) => ({
      ...account,
      active: account.name === activeAccount,
      unlocked: Boolean(await readUnlockedKey(account.name))
    }))
  );
  const signer = await resolveSigner({}).catch(() => ({}) as Signer);

  return {
    source: signer.source ?? configuredPrivateKey.source,
    configured: Boolean(configuredPrivateKey.value),
    valid: environmentValid,
    keychainAvailable,
    keystoreAccounts: accounts,
    defaultSigner: signer.privateKey ? createAccount(signer.privateKey).address : undefined,
    willGenerateOnDeploy: !signer.privateKey,
    note: signer.privateKey
      ? `Signing tools use ${signer.source} by default.`
      : "No signer available: genlayer_deploy will generate a new private key; other signing tools need privateKey, account, or GENLAYER_PRIVATE_KEY."
  };
}

function parseGen(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(amount.trim());
  if (!match) {
    throw new Error(`Invalid GEN amount "${amount}". Use a decimal such as "1" or "0.25" (up to 18 decimals).`);
  }

  return BigInt(match[1]) * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"));
}

function formatGen(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

const genAmountSchema = z.string().regex(/^\d+(\.\d{1,18})?$/, 'Expected a GEN amount such as "1" or "0.25".');

const accountTargetShape = {
  account: signerShape.account,
  address: addressSchema.optional().describe("Address to use instead of a keystore account.")
};

async function resolveTargetAddress(input: { address?: string; account?: string; privateKey?: string }) {
  if (input.address) {
    return input.address as Address;
  }

  if (input.account) {
    const entry = listKeystoreAccounts().find((account) => account.name === input.account);
    if (entry?.address) {
      return entry.address as Address;
    }
  }

  const signer = await resolveSigner(input);
  if (!signer.privateKey) {
    throw new Error("No address given and no default signer available: pass address or account.");
  }

  return createAccount(signer.privateKey).address;
}

const accountInfoShape = {
  ...connectionShape,
  ...accountTargetShape
};

async function accountInfo(input: z.infer<z.ZodObject<typeof accountInfoShape>>) {
  const activeAccount = getActiveKeystoreAccount();
  const keystoreAccounts = await Promise.all(
    listKeystoreAccounts().map(async (account) => ({
      ...account,
      active: account.name === activeAccount,
      unlocked: Boolean(await readUnlockedKey(account.name))
    }))
  );

  const address = await resolveTargetAddress(input).catch(() => undefined);
  let balance: bigint | undefined;
  let balanceError: string | undefined;
  if (address) {
    try {
      const { client } = await makeClient(input, "read");
      balance = await client.getBalance({ address });
    } catch (error) {
      balanceError = errorMessage(error);
    }
  }

  return {
    ok: true,
    chain: input.chain,
    address,
    balanceWei: balance,
    balanceGen: balance === undefined ? undefined : formatGen(balance),
    balanceError,
    keystoreAccounts
  };
}

const fundAccountShape = {
  ...connectionShape,
  ...accountTargetShape,
  amount: genAmountSchema.default("10").describe("Amount of test GEN to mint to the account.")
};

async function fundAccount(input: z.infer<z.ZodObject<typeof fundAccountShape>>) {
  if (!chains[input.chain].isStudio) {
    throw new Error(`${input.chain} has no sim_fundAccount faucet; it only exists on localnet and Studio networks.`);
  }

  const address = await resolveTargetAddress(input);
  const { client } = await makeClient(input, "read");
  const wei = parseGen(input.amount);
  await (client as unknown as { request(args: { method: string; params: unknown[] }): Promise<unknown> }).request({
    method: "sim_fundAccount",
    params: [address, Number(wei)]
  });
  const balance = await client.getBalance({ address });

  return {
    ok: true,
    chain: input.chain,
    address,
    fundedGen: input.amount,
    balanceWei: balance,
    balanceGen: formatGen(balance)
  };
}

const transferShape = {
  ...connectionShape,
  ...signerShape,
  to: addressSchema.describe("Recipient address."),
  amount: genAmountSchema.describe('Amount of GEN to send, e.g. "0.5".')
};

async function transferGen(input: z.infer<z.ZodObject<typeof transferShape>>) {
  const { client, account, privateKeySource } = await makeClient(input, "sign");
  const receipt = await client.transfer({ to: input.to as Address, value: parseGen(input.amount) });

  return {
    ok: receipt.status === "success",
    chain: input.chain,
    from: account.address,
    to: input.to,
    amountGen: input.amount,
    privateKeySource,
    transactionHash: receipt.transactionHash,
    status: receipt.status
  };
}

const simulateWriteShape = {
  ...connectionShape,
  ...signerShape,
  ...callShape,
  value: weiSchema.describe("Native value sent with the call, in wei."),
  leaderOnly: z.boolean().default(false),
  includeFeeEstimate: z.boolean().default(true).describe("Also size the fees this write would need.")
};

async function simulateWrite(input: z.infer<z.ZodObject<typeof simulateWriteShape>>) {
  const { client, account } = await makeClient(input, "read");
  const call = {
    address: input.contractAddress as Address,
    functionName: input.method,
    args: toCalldataArgs(input.args),
    kwargs: toCalldataKwargs(input.kwargs),
    value: input.value === undefined ? undefined : BigInt(input.value),
    leaderOnly: input.leaderOnly
  };

  const simulation = await client.simulateWriteContract({ ...call, includeReceipt: true });

  let fees: unknown;
  let feeEstimateError: string | undefined;
  if (input.includeFeeEstimate) {
    try {
      const estimate = await client.estimateTransactionFeesForWrite(call);
      fees = {
        distribution: estimate.distribution,
        messageAllocations: estimate.messageAllocations,
        feeValue: estimate.feeValue
      };
    } catch (error) {
      feeEstimateError = errorMessage(error);
    }
  }

  return {
    ok: true,
    chain: input.chain,
    contractAddress: input.contractAddress,
    method: input.method,
    sender: account.address,
    result: simulation.result,
    fees,
    feeEstimateError,
    feeReport: simulation.feeReport,
    receipt: simulation.receipt
  };
}

const stakingQueries = ["epoch", "validators", "validator", "delegation", "quarantined", "banned"] as const;

const stakingInfoShape = {
  ...connectionShape,
  query: z
    .enum(stakingQueries)
    .default("epoch")
    .describe(
      "epoch: current epoch and staking parameters. validators: active and joined validator addresses. validator: details for one validator. delegation: a delegator's stake with a validator. quarantined / banned: those validator lists."
    ),
  validator: addressSchema.optional().describe("Validator address (validator and delegation queries)."),
  delegator: addressSchema.optional().describe("Delegator address (delegation query).")
};

async function stakingInfo(input: z.infer<z.ZodObject<typeof stakingInfoShape>>) {
  if (!chains[input.chain].stakingContract) {
    throw new Error(`${input.chain} has no staking contract; staking exists on testnetAsimov and testnetBradbury.`);
  }

  const { client } = await makeClient(input, "read");
  const requireValidator = () => {
    if (!input.validator) {
      throw new Error(`The ${input.query} query needs a validator address.`);
    }

    return input.validator as Address;
  };

  let result: unknown;
  switch (input.query) {
    case "epoch":
      result = await client.getEpochInfo();
      break;
    case "validators": {
      const [active, joined] = await Promise.all([client.getActiveValidators(), client.getJoinedValidators()]);
      result = { activeCount: active.length, joinedCount: joined.length, active, joined };
      break;
    }
    case "validator": {
      const validator = requireValidator();
      result = (await client.isValidator(validator))
        ? { isValidator: true, info: await client.getValidatorInfo(validator) }
        : { isValidator: false };
      break;
    }
    case "delegation": {
      if (!input.delegator) {
        throw new Error("The delegation query needs a delegator address.");
      }

      result = await client.getStakeInfo(input.delegator as Address, requireValidator());
      break;
    }
    case "quarantined":
      result = await client.getQuarantinedValidators();
      break;
    case "banned":
      result = await client.getBannedValidators();
      break;
  }

  return {
    ok: true,
    chain: input.chain,
    query: input.query,
    result
  };
}

const lintContractShape = {
  contractPath: z.string().describe("Path to the Intelligent Contract source file."),
  cwd: z.string().optional().describe("Base directory for resolving contractPath. Defaults to MCP server cwd."),
  mode: z
    .enum(["check", "lint", "validate", "typecheck", "schema"])
    .default("check")
    .describe(
      "check: lint plus validate. lint: fast AST safety checks. validate: SDK semantic validation. typecheck: Pyright with the GenLayer SDK. schema: extract the ABI schema."
    ),
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000).default(180_000)
};

async function lintContract(input: z.infer<z.ZodObject<typeof lintContractShape>>) {
  const contractPath = resolve(input.cwd ?? processCwd(), input.contractPath);
  if (!existsSync(contractPath)) {
    throw new Error(`Contract file not found: ${contractPath}`);
  }

  const result = await runCommand("genvm-lint", {
    args: [input.mode, contractPath, "--json"],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs
  });

  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }

  return {
    ok: result.exitCode === 0,
    mode: input.mode,
    contractPath,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    report,
    stdout: report === undefined ? result.stdout : undefined,
    stderr: result.stderr || undefined,
    error: result.error
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
  version: "0.4.1"
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
      privateKeyConfig: await getPrivateKeyConfigStatus(),
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

server.tool(
  "genlayer_account",
  "Show an account's address and GEN balance on a network, plus the GenLayer CLI keystore accounts and whether each is unlocked (read-only). Defaults to the signer this server would use.",
  accountInfoShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => accountInfo(input)))
);

server.tool(
  "genlayer_fund_account",
  "Mint test GEN to an account with the sim_fundAccount faucet. Only works on localnet and Studio networks.",
  fundAccountShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => fundAccount(input)))
);

server.tool(
  "genlayer_transfer",
  "Send GEN to an address. State-changing: signs with the resolved account and spends funds.",
  transferShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => transferGen(input)))
);

server.tool(
  "genlayer_simulate_write",
  "Dry-run a state-changing contract method without sending a transaction: returns the result, a fee estimate, and the simulation receipt. Studio and localnet only.",
  simulateWriteShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => simulateWrite(input)))
);

server.tool(
  "genlayer_staking_info",
  "Read staking state on testnets (read-only): epoch parameters, validator lists, one validator's details, or a delegation.",
  stakingInfoShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => stakingInfo(input)))
);

server.tool(
  "genlayer_lint_contract",
  "Lint, validate, typecheck, or extract the schema of an Intelligent Contract file with genvm-lint and return the JSON report.",
  lintContractShape,
  async (input) => textResponse(await safeOperation(input.timeoutMs, () => lintContract(input)))
);

const transport = new StdioServerTransport();
await server.connect(transport);
