package com.openauri.usb

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Claims interfaces on demand and gives them back when they are no longer needed.
 *
 * - The first [withClaim] of a sequence claims the interface. It tries a plain claim first and
 *   falls back to `claimInterface(intf, force = true)`; when only the forced claim succeeds the
 *   kernel driver (usually usbhid) was detached, which [Diagnostics.kernelDriverDetached] records.
 * - The interface is released after [idleReleaseMs] (1500 ms by default) without a [withClaim],
 *   on [releaseAll] (call it from `Activity.onStop`) and when the device is detached.
 * - It never resets the device and never calls `setConfiguration`: only claim and release.
 *
 * [withClaim] performs USB I/O and must run off the main thread. [releaseAll], [onClosed],
 * [diagnostics] and [dispose] never block on I/O: releases run on the [scheduler] thread.
 */
class ClaimManager(
    private val backend: UsbBackend,
    private val scheduler: Scheduler,
    private val idleReleaseMs: Long,
) {
    /** Claim manager with a background scheduler and the 1500 ms idle release. */
    constructor(backend: UsbBackend) : this(backend, Scheduler.background(), IDLE_RELEASE_MS)

    /** Runs delayed tasks; injectable so tests drive time by hand. */
    fun interface Scheduler {
        /** Runs [task] once, [delayMs] from now, on a thread other than the main thread. */
        fun schedule(delayMs: Long, task: Runnable): Scheduled

        companion object {
            /** Scheduler backed by a single daemon thread. */
            fun background(): Scheduler = from(
                Executors.newSingleThreadScheduledExecutor { task ->
                    Thread(task, "openauri-usb-claims").apply { isDaemon = true }
                },
            )

            /** Scheduler backed by [executor]. */
            fun from(executor: ScheduledExecutorService): Scheduler = Scheduler { delayMs, task ->
                val future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS)
                Scheduled { future.cancel(false) }
            }
        }
    }

    /** A task returned by [Scheduler.schedule]. */
    fun interface Scheduled {
        /** Prevents the task from running if it has not started yet. */
        fun cancel()
    }

    /** Why an interface was last released. */
    enum class ReleaseReason { IDLE, STOP, DETACHED, CLOSED }

    /**
     * State of one claimed interface, for the USB diagnostics screen.
     *
     * @property kernelDriverDetached true when the last claim needed `force = true`.
     * @property claims number of successful claims on this connection.
     * @property lastError the last failure of a background release, if any.
     */
    class Diagnostics(
        val deviceKey: String,
        val interfaceId: Int,
        val claimed: Boolean,
        val kernelDriverDetached: Boolean,
        val claims: Int,
        val lastRelease: ReleaseReason?,
        val lastError: UsbFailure?,
    )

    private class Claim(val connection: UsbConnectionHandle, val usbInterface: UsbInterfaceInfo) {
        // Guarded by the ClaimManager lock.
        var users = 0
        var generation = 0
        var timer: Scheduled? = null

        // Written while holding this Claim's monitor, which also serialises claim and release I/O.
        @Volatile var claimed = false
        @Volatile var kernelDriverDetached = false
        @Volatile var claims = 0
        @Volatile var lastRelease: ReleaseReason? = null
        @Volatile var lastError: UsbFailure? = null
    }

    private val lock = Any()
    private val claims = LinkedHashMap<Pair<Long, Int>, Claim>()
    private val listener = object : UsbDeviceListener {
        override fun onAttached(device: UsbDeviceInfo) = Unit

        override fun onDetached(device: UsbDeviceInfo) =
            forget(ReleaseReason.DETACHED) { it.connection.device.key == device.key }
    }

    init {
        backend.addListener(listener)
    }

    /**
     * Runs [block] (typically one report send) with [usbInterface] claimed on [connection],
     * claiming it first if needed, then re-arms the idle release.
     *
     * @throws UsbFailure.Busy when neither a plain nor a forced claim succeeds; [block] is not run.
     */
    fun <T> withClaim(connection: UsbConnectionHandle, usbInterface: UsbInterfaceInfo, block: () -> T): T {
        val claim = synchronized(lock) {
            claims.getOrPut(connection.id to usbInterface.id) { Claim(connection, usbInterface) }
                .also { claim ->
                    claim.users++
                    disarm(claim)
                }
        }
        try {
            ensureClaimed(claim)
            return block()
        } finally {
            synchronized(lock) {
                claim.users--
                if (claim.users == 0) arm(claim)
            }
        }
    }

    /** Releases every claimed interface now (Activity `onStop`). Safe on the main thread. */
    fun releaseAll() {
        val all = synchronized(lock) { claims.values.toList().onEach { disarm(it) } }
        all.forEach { claim -> scheduler.schedule(0) { release(claim, ReleaseReason.STOP) } }
    }

    /** Forgets the claims of [connection], which the caller closes (closing releases them). */
    fun onClosed(connection: UsbConnectionHandle) =
        forget(ReleaseReason.CLOSED) { it.connection.id == connection.id }

    /** Snapshot of every interface this manager has claimed. */
    fun diagnostics(): List<Diagnostics> = synchronized(lock) {
        claims.values.map {
            Diagnostics(
                deviceKey = it.connection.device.key,
                interfaceId = it.usbInterface.id,
                claimed = it.claimed,
                kernelDriverDetached = it.kernelDriverDetached,
                claims = it.claims,
                lastRelease = it.lastRelease,
                lastError = it.lastError,
            )
        }
    }

    /** Stops listening to the backend and cancels pending idle releases. */
    fun dispose() {
        backend.removeListener(listener)
        synchronized(lock) { claims.values.forEach { disarm(it) } }
    }

    private fun ensureClaimed(claim: Claim) {
        synchronized(claim) {
            if (claim.claimed) return
            val connection = claim.connection
            val usbInterface = claim.usbInterface
            val forced = when {
                backend.claim(connection, usbInterface, false) -> false
                backend.claim(connection, usbInterface, true) -> true
                else -> throw UsbFailure.Busy(
                    connection.device.key,
                    "interface ${usbInterface.id} is held by another driver or process",
                )
            }
            claim.kernelDriverDetached = forced
            claim.claims++
            claim.claimed = true
        }
    }

    private fun release(claim: Claim, reason: ReleaseReason) {
        synchronized(claim) {
            if (!claim.claimed) return
            claim.claimed = false
            claim.lastRelease = reason
            try {
                backend.release(claim.connection, claim.usbInterface)
            } catch (failure: UsbFailure) {
                claim.lastError = failure
            }
        }
    }

    /**
     * Every [withClaim] entry bumps the generation before raising `users`, so a matching
     * generation means nobody has used the claim since the timer was armed.
     * Lock order: the Claim monitor, then [lock]; nothing takes them in the opposite order.
     */
    private fun releaseIfIdle(claim: Claim, generation: Int) {
        synchronized(claim) {
            val idle = synchronized(lock) { claim.generation == generation }
            if (idle) release(claim, ReleaseReason.IDLE)
        }
    }

    private fun forget(reason: ReleaseReason, predicate: (Claim) -> Boolean) {
        synchronized(lock) {
            claims.values.filter(predicate).forEach { claim ->
                disarm(claim)
                claim.claimed = false
                claim.lastRelease = reason
            }
        }
    }

    /** Called with [lock] held. */
    private fun arm(claim: Claim) {
        val generation = ++claim.generation
        claim.timer = scheduler.schedule(idleReleaseMs) { releaseIfIdle(claim, generation) }
    }

    /** Called with [lock] held. */
    private fun disarm(claim: Claim) {
        claim.generation++
        claim.timer?.cancel()
        claim.timer = null
    }

    companion object {
        /** Idle time after which a claimed interface is released. */
        const val IDLE_RELEASE_MS: Long = 1500
    }
}
