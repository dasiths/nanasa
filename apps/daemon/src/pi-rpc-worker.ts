import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { JsonlFramer, JsonlProtocolError, parseJsonRecord, writeJsonLine } from "./pi-jsonl.js";
import { PiRpcProcess, type PiRpcState, validatePiReadiness } from "./pi-rpc-process.js";
import type {
  WorkerEvent,
  WorkerRequest,
  WorkerResponse,
  WorkerSettlementEvent,
  WorkerSnapshot,
} from "./pi-rpc-worker-protocol.js";
import { validateSessionFile } from "./pi-rpc-worker-protocol.js";

interface WorkerLaunchConfiguration {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
}

export interface PiRpcWorkerOptions {
  socketPath: string;
  sessionDirectory: string;
  runId: string;
  generation: number;
  onFatal?: (error: Error) => void;
  createPiProcess?: (configuration: WorkerLaunchConfiguration) => PiRpcProcess;
}

type DeliveryState = "pending" | "accepted" | "settled";

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JsonlProtocolError("pi_worker_request_must_be_object");
  }
  return value as Record<string, unknown>;
}

function parseLaunchConfiguration(value: Record<string, unknown>): WorkerLaunchConfiguration {
  if (
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    !Array.isArray(value.args) ||
    !value.args.every((argument) => typeof argument === "string") ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd) ||
    typeof value.environment !== "object" ||
    value.environment === null ||
    Array.isArray(value.environment)
  ) {
    throw new Error("pi_worker_launch_configuration_invalid");
  }
  const environment = value.environment as Record<string, unknown>;
  if (
    !Object.entries(environment).every(
      ([name, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof entry === "string",
    )
  ) {
    throw new Error("pi_worker_environment_invalid");
  }
  if (
    value.args.some((argument) => ["--mode", "--session-dir", "--no-session"].includes(argument))
  ) {
    throw new Error("pi_worker_reserved_pi_argument");
  }
  return {
    command: value.command,
    args: value.args as string[],
    cwd: value.cwd,
    environment: environment as Record<string, string>,
  };
}

function launchFingerprint(configuration: WorkerLaunchConfiguration): string {
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

export class PiRpcWorker {
  readonly #options: PiRpcWorkerOptions;
  readonly #settlements: WorkerSettlementEvent[] = [];
  readonly #deliveries = new Map<string, DeliveryState>();
  readonly #acceptedSinceSettlement = new Set<string>();
  readonly #settlementWaiters = new Set<() => void>();
  #server: Server | undefined;
  #client: Socket | undefined;
  #clientWriteLane: Promise<void> = Promise.resolve();
  #pi: PiRpcProcess | undefined;
  #state: PiRpcState | undefined;
  #readinessReason: string | undefined;
  #configurationFingerprint: string | undefined;
  #settlementSequence = 0;
  #busy = false;
  #closing = false;

  public constructor(options: PiRpcWorkerOptions) {
    this.#options = options;
  }

  public async start(): Promise<void> {
    const socketDirectory = dirname(this.#options.socketPath);
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
    chmodSync(socketDirectory, 0o700);
    mkdirSync(this.#options.sessionDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.#options.sessionDirectory, 0o700);
    await this.#removeStaleSocket();
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#options.socketPath, () => {
        this.#server!.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.#options.socketPath, 0o600);
    this.#log("worker ready");
  }

  public async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#client?.destroy();
    this.#pi?.close();
    if (this.#server !== undefined) {
      await new Promise<void>((resolve) => this.#server!.close(() => resolve()));
    }
    if (existsSync(this.#options.socketPath)) unlinkSync(this.#options.socketPath);
  }

  #accept(socket: Socket): void {
    this.#client?.destroy();
    this.#client = socket;
    this.#clientWriteLane = Promise.resolve();
    let requestLane = Promise.resolve();
    const framer = new JsonlFramer({
      onRecord: (record) => {
        requestLane = requestLane.then(() => this.#handleRecord(socket, record));
        void requestLane.catch((error: unknown) => {
          this.#fatal(error, false);
          socket.destroy();
        });
      },
    });
    socket.on("data", (chunk) => {
      try {
        framer.write(chunk);
      } catch (error) {
        this.#fatal(error, false);
        socket.destroy();
      }
    });
    socket.once("end", () => {
      try {
        framer.end();
      } catch (error) {
        this.#fatal(error, false);
      }
    });
    socket.once("close", () => {
      if (this.#client === socket) this.#client = undefined;
      this.#log("daemon disconnected");
    });
    this.#log("daemon connected");
  }

  async #handleRecord(socket: Socket, record: string): Promise<void> {
    const value = asObject(parseJsonRecord(record));
    const request = value as unknown as WorkerRequest;
    if (
      typeof request.id !== "string" ||
      typeof request.type !== "string" ||
      request.runId !== this.#options.runId ||
      request.generation !== this.#options.generation
    ) {
      throw new JsonlProtocolError("pi_worker_generation_mismatch");
    }
    const response: WorkerResponse = {
      id: request.id,
      type: "response",
      command: request.type,
      success: true,
    };
    try {
      response.data = await this.#execute(request, value);
    } catch (error) {
      response.success = false;
      response.error = error instanceof Error ? error.message : "pi_worker_command_failed";
    }
    await this.#write(socket, response);
    if (request.type === "shutdown" && response.success) {
      setImmediate(() => void this.close());
    }
  }

  async #execute(request: WorkerRequest, value: Record<string, unknown>): Promise<unknown> {
    switch (request.type) {
      case "hello":
        return this.#snapshot();
      case "initialize":
        return this.#initialize(parseLaunchConfiguration(value));
      case "deliver":
        return this.#deliver(value);
      case "abort":
        return this.#abort();
      case "shutdown":
        return { stopped: true };
      default:
        throw new Error("pi_worker_command_unknown");
    }
  }

  async #initialize(configuration: WorkerLaunchConfiguration): Promise<WorkerSnapshot> {
    const fingerprint = launchFingerprint(configuration);
    if (this.#pi !== undefined) {
      if (fingerprint !== this.#configurationFingerprint) {
        throw new Error("pi_worker_launch_configuration_mismatch");
      }
      return this.#snapshot();
    }
    this.#configurationFingerprint = fingerprint;
    const createPiProcess =
      this.#options.createPiProcess ??
      ((launch: WorkerLaunchConfiguration) =>
        new PiRpcProcess({
          command: launch.command,
          args: [...launch.args, "--mode", "rpc", "--session-dir", this.#options.sessionDirectory],
          cwd: launch.cwd,
          env: { ...process.env, ...launch.environment },
        }));
    const pi = createPiProcess(configuration);
    this.#pi = pi;
    pi.on("event", (event: Record<string, unknown>) => this.#handlePiEvent(event));
    pi.on("failure", (error: Error) => this.#fatal(error));
    try {
      this.#state = await pi.handshake();
      this.#busy = this.#state.isStreaming || this.#state.isCompacting;
      this.#readinessReason = validatePiReadiness(this.#state, pi.stderrTail);
      if (this.#state.sessionFile !== undefined) {
        validateSessionFile(this.#options.sessionDirectory, this.#state.sessionFile);
      }
    } catch (error) {
      pi.close();
      this.#pi = undefined;
      this.#state = undefined;
      this.#configurationFingerprint = undefined;
      this.#busy = false;
      throw error;
    }
    this.#log(
      this.#readinessReason === undefined
        ? `Pi session ${this.#state.sessionId} ready`
        : `Pi unavailable: ${this.#readinessReason}`,
    );
    return this.#snapshot();
  }

  async #deliver(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const pi = this.#requireReadyPi();
    if (
      typeof value.deliveryId !== "string" ||
      value.deliveryId.length === 0 ||
      typeof value.message !== "string" ||
      (value.mode !== "queue" && value.mode !== "steer")
    ) {
      throw new Error("pi_worker_delivery_invalid");
    }
    const existing = this.#deliveries.get(value.deliveryId);
    if (existing !== undefined) {
      return {
        duplicate: true,
        settled: existing === "settled",
        session: this.#sessionData(),
      };
    }
    const busy =
      this.#busy || this.#state?.isStreaming === true || this.#state?.isCompacting === true;
    const piCommand = busy ? (value.mode === "queue" ? "follow_up" : "steer") : "prompt";
    this.#deliveries.set(value.deliveryId, "pending");
    this.#acceptedSinceSettlement.add(value.deliveryId);
    try {
      await pi.command({ type: piCommand, message: value.message });
      if (this.#deliveries.get(value.deliveryId) === "pending") {
        this.#deliveries.set(value.deliveryId, "accepted");
      }
      this.#state = await pi.handshake();
      this.#busy =
        this.#state.isStreaming || this.#state.isCompacting || this.#state.pendingMessageCount > 0;
      if (this.#state.sessionFile !== undefined) {
        validateSessionFile(this.#options.sessionDirectory, this.#state.sessionFile);
      }
      this.#log(`delivery accepted via ${piCommand}`);
      return {
        duplicate: false,
        settled: this.#deliveries.get(value.deliveryId) === "settled",
        piCommand,
        session: this.#sessionData(),
      };
    } catch (error) {
      this.#deliveries.delete(value.deliveryId);
      this.#acceptedSinceSettlement.delete(value.deliveryId);
      throw error;
    }
  }

  async #abort(): Promise<Record<string, unknown>> {
    const pi = this.#requireReadyPi();
    const sequence = this.#settlementSequence;
    const shouldAwaitSettlement = this.#busy;
    const settled = shouldAwaitSettlement ? this.#waitForSettlement(sequence) : undefined;
    await pi.command({ type: "abort" });
    if (settled !== undefined) await settled;
    this.#log("abort completed");
    return { settled: shouldAwaitSettlement };
  }

  #handlePiEvent(event: Record<string, unknown>): void {
    if (event.type === "agent_start") this.#busy = true;
    if (event.type === "agent_settled") {
      this.#busy = false;
      const deliveryIds = [...this.#acceptedSinceSettlement];
      this.#acceptedSinceSettlement.clear();
      for (const deliveryId of deliveryIds) this.#deliveries.set(deliveryId, "settled");
      const settlement: WorkerSettlementEvent = {
        type: "delivery_settled",
        sequence: ++this.#settlementSequence,
        deliveryIds,
      };
      this.#settlements.push(settlement);
      if (this.#settlements.length > 256) this.#settlements.shift();
      for (const resolve of this.#settlementWaiters) resolve();
      this.#settlementWaiters.clear();
      void this.#emit(settlement);
      this.#log(`settled ${deliveryIds.length} deliveries`);
    }
    void this.#emit({ type: "pi_event", event });
  }

  #waitForSettlement(afterSequence: number): Promise<void> {
    if (this.#settlementSequence > afterSequence) return Promise.resolve();
    return new Promise((resolve) => this.#settlementWaiters.add(resolve));
  }

  #snapshot(): WorkerSnapshot {
    return {
      initialized: this.#pi !== undefined,
      busy: this.#busy,
      ...(this.#state === undefined ? {} : { state: this.#state }),
      ...(this.#readinessReason === undefined ? {} : { readinessReason: this.#readinessReason }),
      settlementSequence: this.#settlementSequence,
      settlements: [...this.#settlements],
    };
  }

  #sessionData(): Record<string, unknown> {
    const state = this.#state;
    if (state === undefined) throw new Error("pi_worker_not_initialized");
    return {
      sessionId: state.sessionId,
      ...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
    };
  }

  #requireReadyPi(): PiRpcProcess {
    if (this.#pi === undefined) throw new Error("pi_worker_not_initialized");
    if (this.#readinessReason !== undefined) throw new Error(this.#readinessReason);
    return this.#pi;
  }

  #emit(event: WorkerEvent): Promise<void> {
    const client = this.#client;
    return client === undefined ? Promise.resolve() : this.#write(client, event);
  }

  #write(socket: Socket, value: unknown): Promise<void> {
    const operation = this.#clientWriteLane.then(() => writeJsonLine(socket, value));
    this.#clientWriteLane = operation.catch(() => undefined);
    return operation;
  }

  async #removeStaleSocket(): Promise<void> {
    if (!existsSync(this.#options.socketPath)) return;
    if (!lstatSync(this.#options.socketPath).isSocket()) {
      throw new Error("pi_worker_socket_path_occupied");
    }
    const active = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ path: this.#options.socketPath });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (active) throw new Error("pi_worker_already_running");
    unlinkSync(this.#options.socketPath);
  }

  #fatal(error: unknown, terminate = true): void {
    const failure = error instanceof Error ? error : new Error("pi_worker_failed");
    this.#log(`failure: ${failure.message}`);
    if (terminate) {
      this.#options.onFatal?.(failure);
      void this.close();
    }
  }

  #log(message: string): void {
    process.stdout.write(`[nanasa pi] ${message}\n`);
  }
}

function parseArguments(argv: string[]): PiRpcWorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Invalid Pi worker arguments");
    }
    values.set(name, value);
  }
  const socketPath = values.get("--socket");
  const sessionDirectory = values.get("--session-dir");
  const runId = values.get("--run-id");
  const generation = Number(values.get("--generation"));
  if (
    socketPath === undefined ||
    sessionDirectory === undefined ||
    runId === undefined ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    throw new Error("Missing Pi worker arguments");
  }
  return { socketPath, sessionDirectory, runId, generation };
}

async function main(): Promise<void> {
  const worker = new PiRpcWorker({
    ...parseArguments(process.argv.slice(2)),
    onFatal: () => {
      process.exitCode = 1;
    },
  });
  const close = async () => {
    await worker.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await worker.start();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Pi worker failed");
    process.exitCode = 1;
  });
}
