/**
 * Lifecycle manager for the C# Openness controller subprocess.
 *
 * The controller is one long-lived child process per plugin instance. It is
 * spawned on demand, owns the TIA Portal session for as long as it lives, and is
 * terminated by the disposer the plugin registers through `ctx.effect`, so
 * unloading the plugin never leaves the controller behind.
 *
 * Design rules implemented here:
 *
 * - **Serialized requests.** Openness objects are not thread safe, so at most one
 *   operation is in flight. Further requests queue up to `maxQueue`.
 * - **Hard deadlines.** A controller operation that cannot be cancelled (Openness
 *   offers none) is abandoned by terminating the process. The next request starts
 *   a fresh controller, and the session state is reported as lost.
 * - **ASCII-safe framing.** Requests are serialized with every non-ASCII code
 *   point escaped, which makes the channel immune to console code pages.
 * - **Nothing is trusted.** Frames are validated before use; unknown output from
 *   the .NET runtime is collected as diagnostics instead of corrupting a result.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolFailure } from './errors.js';
import { PROTOCOL_VERSION, isProgressFrame, isReadyFrame, isResultFrame, parseFrame, } from './protocol.js';
export const silentLog = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};
/** Directory of this module (`<package>/lib`). */
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
/** Package root, used to locate the bundled controller. */
export const packageRoot = dirname(moduleDirectory);
/** The controller binary shipped inside this package. */
export function bundledControllerPath() {
    return join(packageRoot, 'controller', 'bin', 'TiaOpennessV17Min.Controller.exe');
}
/**
 * Resolves the controller to run: an explicit configuration wins, then the
 * documented environment override, then the binary shipped with the package.
 */
export function resolveControllerPath(configured) {
    if (configured.trim().length > 0) {
        const path = isAbsolute(configured) ? configured : resolve(configured);
        return { path, source: 'config' };
    }
    const fromEnvironment = process.env['TIA_OPENNESS_V17_MIN_CONTROLLER'];
    if (typeof fromEnvironment === 'string' && fromEnvironment.trim().length > 0) {
        const path = isAbsolute(fromEnvironment) ? fromEnvironment : resolve(fromEnvironment);
        return { path, source: 'environment' };
    }
    return { path: bundledControllerPath(), source: 'package' };
}
const TAIL_LIMIT = 40;
/**
 * Escapes every non-ASCII code point so a request line is pure ASCII, which
 * keeps the channel correct regardless of the console code page the child
 * process inherited.
 */
export function asciiStringify(value) {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    });
}
export class ControllerProcess {
    #options;
    #child = null;
    #state = 'stopped';
    #ready = null;
    #starting = null;
    #startedAt = null;
    #pending = new Map();
    #stdoutBuffer = '';
    #stderrTail = [];
    #unexpectedOutput = [];
    #queue = Promise.resolve();
    #queueDepth = 0;
    #requestsServed = 0;
    #restarts = 0;
    #lastError = null;
    #stopRequested = false;
    #exitWaiters = [];
    #readyWaiters = [];
    constructor(options) {
        this.#options = options;
    }
    get state() {
        return this.#state;
    }
    get pid() {
        return this.#child?.pid ?? null;
    }
    /** Starts the controller if it is not running; resolves with the ready frame. */
    async start() {
        if (this.#ready !== null && (this.#state === 'ready' || this.#state === 'busy'))
            return this.#ready;
        if (this.#starting !== null)
            return await this.#starting;
        const starting = this.#doStart();
        this.#starting = starting;
        try {
            return await starting;
        }
        finally {
            if (this.#starting === starting)
                this.#starting = null;
        }
    }
    /**
     * Starts the controller without failing the caller: used by the plugin to pay
     * the spawn cost up front while keeping load failures non-fatal.
     */
    async prewarm() {
        try {
            await this.start();
            return true;
        }
        catch (error) {
            this.#options.log.warn(`The TIA Openness controller could not be started up front: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    /**
     * Performs one whitelisted operation and resolves with the result frame. The
     * promise rejects only for transport failures; an operation that ran and failed
     * resolves with `ok: false`.
     */
    async request(operation, params, options = {}) {
        if (this.#queueDepth >= this.#options.maxQueue) {
            throw new ToolFailure('controller_busy', `The controller queue already holds ${this.#queueDepth} request(s); the limit is ${this.#options.maxQueue}. Wait for the running operation or raise maxQueue.`, { operation, queueDepth: this.#queueDepth, maxQueue: this.#options.maxQueue });
        }
        this.#queueDepth += 1;
        const run = this.#queue.then(async () => await this.#execute(operation, params, options), async () => await this.#execute(operation, params, options));
        // Keep the chain alive after a rejection so one failure cannot poison the queue.
        this.#queue = run.then(() => undefined, () => undefined);
        try {
            return await run;
        }
        finally {
            this.#queueDepth -= 1;
        }
    }
    async #execute(operation, params, options) {
        await this.start();
        const child = this.#child;
        if (child === null || child.stdin.destroyed || !child.stdin.writable) {
            throw new ToolFailure('controller_unavailable', 'The controller process is not accepting requests.', { operation });
        }
        const id = randomUUID();
        const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
        this.#state = 'busy';
        return await new Promise((resolvePromise, rejectPromise) => {
            const pending = {
                id,
                operation,
                settled: false,
                resolve: resolvePromise,
                reject: rejectPromise,
            };
            if (options.onProgress !== undefined)
                pending.onProgress = options.onProgress;
            const settle = () => {
                if (pending.settled)
                    return false;
                pending.settled = true;
                clearTimeout(pending.timer);
                pending.detachAbort?.();
                this.#pending.delete(id);
                if (this.#pending.size === 0 && this.#state === 'busy')
                    this.#state = 'ready';
                return true;
            };
            pending.resolve = (frame) => {
                if (!settle())
                    return;
                resolvePromise(frame);
            };
            pending.reject = (error) => {
                if (!settle())
                    return;
                rejectPromise(error);
            };
            pending.timer = setTimeout(() => {
                if (pending.settled)
                    return;
                const message = `The controller did not answer ${operation} within ${timeoutMs} ms. Openness calls cannot be cancelled, ` +
                    'so the controller was terminated; the next call starts a new controller and the previous TIA Portal session is gone.';
                this.#options.log.error(message);
                pending.reject(new ToolFailure('controller_timeout', message, { operation, timeoutMs, pid: this.#child?.pid ?? null }));
                this.#hardAbort('controller_timeout', message);
            }, timeoutMs);
            const signal = options.signal;
            if (signal !== undefined) {
                const onAbort = () => {
                    if (pending.settled)
                        return;
                    const message = `The ${operation} request was cancelled. The controller was terminated because an Openness call cannot be interrupted.`;
                    pending.reject(new ToolFailure('controller_cancelled', message, { operation }));
                    this.#hardAbort('controller_cancelled', message);
                };
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
                pending.detachAbort = () => signal.removeEventListener('abort', onAbort);
            }
            this.#pending.set(id, pending);
            try {
                child.stdin.write(`${asciiStringify({ id, operation, params })}\n`, 'utf8');
                this.#options.log.debug(`controller <- ${operation} (${id})`);
            }
            catch (error) {
                pending.reject(new ToolFailure('controller_write_failed', `The request could not be written to the controller: ${error instanceof Error ? error.message : String(error)}`, { operation }));
            }
        });
    }
    /** Stops the controller gracefully, then by force if it does not exit in time. */
    async stop(graceMs = this.#options.shutdownGraceMs) {
        // A start that is still in flight must finish first, otherwise stopping here
        // would leave a freshly spawned child behind.
        if (this.#starting !== null) {
            try {
                await this.#starting;
            }
            catch {
                // A failed start has nothing to stop.
            }
        }
        const child = this.#child;
        if (child === null) {
            this.#state = 'stopped';
            this.#ready = null;
            return;
        }
        this.#stopRequested = true;
        this.#state = 'stopping';
        // Closing stdin is the documented graceful path: the controller closes the
        // project and the TIA Portal instance it started, then exits.
        try {
            child.stdin.end();
        }
        catch {
            // The pipe is already gone; fall through to the forced path.
        }
        const exited = await this.#waitForExit(graceMs);
        if (!exited) {
            this.#options.log.warn(`The controller did not exit within ${graceMs} ms; terminating it.`);
            this.#kill();
            await this.#waitForExit(2_000);
            if (this.#child !== null) {
                this.#kill('SIGKILL');
                await this.#waitForExit(2_000);
            }
        }
        this.#state = 'stopped';
        this.#ready = null;
    }
    /** Immediate termination; used on unload and on unrecoverable transport errors. */
    #hardAbort(code, message) {
        this.#lastError = { code, message };
        this.#state = 'failed';
        this.#kill();
    }
    #kill(signal = 'SIGKILL') {
        const child = this.#child;
        if (child === null)
            return;
        this.#killChild(child, signal);
    }
    /**
     * Terminates one specific child, whether or not it is still the current one.
     * The controller has no children of its own, and TIA Portal is a separate
     * process that is never killed from here.
     */
    #killChild(child, signal = 'SIGKILL') {
        try {
            // On Windows any signal terminates the process.
            child.kill(signal);
        }
        catch (error) {
            this.#options.log.warn(`Terminating the controller failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async #waitForExit(timeoutMs) {
        if (this.#child === null)
            return true;
        if (timeoutMs <= 0)
            return this.#child === null;
        return await new Promise((resolvePromise) => {
            const waiter = () => {
                clearTimeout(timer);
                resolvePromise(true);
            };
            const timer = setTimeout(() => {
                const index = this.#exitWaiters.indexOf(waiter);
                if (index >= 0)
                    this.#exitWaiters.splice(index, 1);
                resolvePromise(this.#child === null);
            }, timeoutMs);
            this.#exitWaiters.push(waiter);
        });
    }
    /** Current lifecycle and diagnostics snapshot. */
    status() {
        const { path: exePath } = resolveControllerPath(this.#options.exePath);
        const firstPending = [...this.#pending.values()][0];
        return {
            state: this.#state,
            exePath,
            exeExists: existsSync(exePath),
            pid: this.pid,
            startedAt: this.#startedAt,
            requestsServed: this.#requestsServed,
            restarts: this.#restarts,
            queueDepth: this.#queueDepth,
            inflightOperation: firstPending?.operation ?? null,
            lastError: this.#lastError,
            ready: this.#ready,
            stderrTail: [...this.#stderrTail],
            unexpectedOutput: [...this.#unexpectedOutput],
        };
    }
    // ------------------------------------------------------------------ internals
    async #doStart() {
        const { path: exePath, source } = resolveControllerPath(this.#options.exePath);
        if (!existsSync(exePath)) {
            const failure = new ToolFailure('controller_not_found', `The TIA Openness controller was not found at ${exePath}. Build it with "npm run build:controller", install the ` +
                'package including controller/bin, or point the controllerPath config (or TIA_OPENNESS_V17_MIN_CONTROLLER) at the executable. ' +
                'TIA Portal V17 Openness and Windows x64 are required.', { exePath, source, platform: process.platform, arch: process.arch });
            // Recording the failure makes controller_status explain it without the
            // caller having to retry a failing operation.
            this.#lastError = { code: failure.code, message: failure.message };
            this.#state = 'failed';
            throw failure;
        }
        if (this.#restarts > 0 || this.#state === 'failed')
            this.#options.log.info('Starting a new TIA Openness controller process.');
        // A previous child may still be dying (its `exit` event has not arrived yet).
        // Detaching it first means its late events are ignored, and killing it here
        // means a replacement can never leave an untracked process behind.
        const previousChild = this.#child;
        if (previousChild !== null) {
            this.#child = null;
            this.#killChild(previousChild);
        }
        const args = this.#options.launchArgs !== undefined
            ? [...this.#options.launchArgs]
            : this.#options.opennessDir.length > 0
                ? ['--stdio', '--openness-dir', this.#options.opennessDir]
                : ['--stdio'];
        let child;
        try {
            child = spawn(exePath, args, {
                cwd: dirname(exePath),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (error) {
            throw new ToolFailure('controller_spawn_failed', `The controller could not be started: ${error instanceof Error ? error.message : String(error)}`, { exePath });
        }
        this.#child = child;
        this.#state = 'starting';
        this.#stopRequested = false;
        this.#stdoutBuffer = '';
        // Every handler checks that the event still belongs to the current child.
        // Without that check a late event from a replaced child would clear the new
        // child's reference (orphaning it), or feed stale output into a live request.
        const isCurrent = () => this.#child === child;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            if (isCurrent())
                this.#onStdout(chunk);
        });
        child.stderr.on('data', (chunk) => {
            if (isCurrent())
                this.#onStderr(chunk);
        });
        child.on('error', (error) => {
            if (isCurrent())
                this.#onChildError(error);
        });
        child.on('exit', (code, signal) => {
            if (isCurrent())
                this.#onExit(code, signal);
        });
        try {
            const ready = await this.#awaitReady();
            if (!isCurrent()) {
                throw new ToolFailure('controller_restarted', 'The controller was replaced while it was starting.', { exePath });
            }
            this.#ready = ready;
            this.#state = 'ready';
            this.#startedAt = new Date().toISOString();
            return ready;
        }
        catch (error) {
            if (isCurrent()) {
                this.#child = null;
                this.#state = 'failed';
            }
            this.#killChild(child);
            throw error;
        }
    }
    async #awaitReady() {
        const deadline = this.#options.startupTimeoutMs;
        return await new Promise((resolvePromise, rejectPromise) => {
            let settled = false;
            const finish = (action) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                this.#readyWaiters = this.#readyWaiters.filter((waiter) => waiter !== onReady);
                action();
            };
            const onReady = (outcome) => {
                if (outcome instanceof ToolFailure) {
                    finish(() => rejectPromise(outcome));
                    return;
                }
                if (outcome.protocol !== PROTOCOL_VERSION) {
                    finish(() => rejectPromise(new ToolFailure('controller_protocol_mismatch', `The controller speaks protocol ${outcome.protocol} but this plugin expects ${PROTOCOL_VERSION}. Rebuild the controller from this package.`, { controllerProtocol: outcome.protocol, pluginProtocol: PROTOCOL_VERSION })));
                    return;
                }
                finish(() => resolvePromise(outcome));
            };
            const timer = setTimeout(() => {
                finish(() => rejectPromise(new ToolFailure('controller_handshake_timeout', `The controller did not report readiness within ${deadline} ms. It may be blocked by a TIA Portal installation problem; ` +
                    'the captured output is attached.', { stderr: [...this.#stderrTail] })));
            }, deadline);
            this.#readyWaiters.push(onReady);
        });
    }
    #onStdout(chunk) {
        this.#stdoutBuffer += chunk;
        let index = this.#stdoutBuffer.indexOf('\n');
        while (index >= 0) {
            const line = this.#stdoutBuffer.slice(0, index).replace(/\r$/, '');
            this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
            if (line.trim().length > 0)
                this.#onLine(line);
            index = this.#stdoutBuffer.indexOf('\n');
        }
    }
    #onLine(line) {
        const frame = parseFrame(line);
        if (frame === null) {
            // Anything the .NET runtime writes to stdout that is not a frame is kept as
            // a diagnostic instead of being mistaken for a protocol message.
            this.#pushTail(this.#unexpectedOutput, line);
            if (this.#options.logControllerOutput)
                this.#options.log.info(`controller stdout: ${line}`);
            return;
        }
        switch (frame.type) {
            case 'ready':
                if (isReadyFrame(frame)) {
                    this.#options.log.debug(`controller ready (pid ${frame.pid}, Openness at ${frame.openness?.assemblyPath ?? 'unknown'})`);
                    for (const waiter of [...this.#readyWaiters])
                        waiter(frame);
                }
                return;
            case 'progress':
                if (isProgressFrame(frame))
                    this.#onProgress(frame);
                return;
            case 'result':
                if (isResultFrame(frame))
                    this.#onResult(frame);
                return;
            case 'log':
                if (frame.message !== undefined) {
                    this.#pushTail(this.#unexpectedOutput, frame.message);
                    if (this.#options.logControllerOutput)
                        this.#options.log.info(`controller: ${frame.message}`);
                }
                return;
        }
    }
    #onProgress(frame) {
        if (this.#options.logControllerOutput)
            this.#options.log.info(`controller progress [${frame.phase}] ${frame.message}`);
        const pending = frame.id === undefined ? undefined : this.#pending.get(frame.id);
        pending?.onProgress?.(frame);
    }
    #onResult(frame) {
        this.#requestsServed += 1;
        const id = frame.id;
        if (id === undefined) {
            this.#pushTail(this.#unexpectedOutput, `A result frame without a correlation id: ${JSON.stringify(frame).slice(0, 200)}`);
            return;
        }
        const pending = this.#pending.get(id);
        if (pending === undefined) {
            this.#pushTail(this.#unexpectedOutput, `A result frame for an unknown request id ${id}.`);
            return;
        }
        pending.resolve(frame);
    }
    #onStderr(chunk) {
        for (const rawLine of chunk.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (line.length === 0)
                continue;
            this.#pushTail(this.#stderrTail, line);
            if (this.#options.logControllerOutput)
                this.#options.log.info(`controller stderr: ${line}`);
        }
    }
    #onChildError(error) {
        const failure = new ToolFailure('controller_spawn_failed', `The controller process reported an error: ${error.message}`, {
            exePath: this.#options.exePath,
            platform: process.platform,
        });
        this.#lastError = { code: failure.code, message: failure.message };
        this.#rejectReadyWaiters(failure);
        this.#failPending(failure);
    }
    #rejectReadyWaiters(failure) {
        for (const waiter of [...this.#readyWaiters])
            waiter(failure);
        this.#readyWaiters = [];
    }
    #onExit(code, signal) {
        const wasStopping = this.#stopRequested || this.#state === 'stopping';
        this.#child = null;
        this.#ready = null;
        this.#startedAt = null;
        for (const waiter of [...this.#exitWaiters])
            waiter();
        this.#exitWaiters = [];
        if (wasStopping) {
            this.#state = 'stopped';
            return;
        }
        this.#state = 'failed';
        const detail = `exit code ${code ?? 'none'}${signal === null ? '' : `, signal ${signal}`}`;
        const failure = new ToolFailure('controller_exited', `The controller exited unexpectedly (${detail}). Captured stderr: ${this.#stderrTail.slice(-5).join(' | ') || 'none'}`, { code, signal, stderr: [...this.#stderrTail], servedOperations: this.#requestsServed });
        this.#lastError = { code: failure.code, message: failure.message };
        // A restart is only counted when a request had to be abandoned; the next
        // request spawns a fresh controller automatically.
        if (this.#pending.size > 0)
            this.#restarts += 1;
        this.#rejectReadyWaiters(failure);
        this.#failPending(failure);
    }
    #failPending(error) {
        for (const pending of [...this.#pending.values()]) {
            pending.reject(error);
        }
        // Rejections above settle their entries; drop anything left for safety.
        this.#pending.clear();
    }
    #pushTail(target, line) {
        target.push(line);
        if (target.length > TAIL_LIMIT)
            target.splice(0, target.length - TAIL_LIMIT);
    }
}
