package com.openauri.usb

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import androidx.core.content.ContextCompat

/**
 * Runs USB permission requests: at most one system dialog per device at a time, with every
 * concurrent caller for that device sharing its answer.
 *
 * Each request registers its own receiver for the private action [ACTION_PERMISSION] with
 * `RECEIVER_NOT_EXPORTED`, and hands the platform a broadcast [PendingIntent] that is:
 * - explicit (`setPackage(context.packageName)`): with target 34 or later a mutable implicit
 *   intent is rejected, and the explicit package also keeps the answer inside the app;
 * - `FLAG_MUTABLE`: the platform fills in [UsbManager.EXTRA_PERMISSION_GRANTED] and
 *   [UsbManager.EXTRA_DEVICE], which an immutable intent would drop. Below API 31 pending intents
 *   are mutable by default and the flag bit is ignored.
 *
 * The answer is sent through our own pending intent, so it carries our UID and reaches the
 * not-exported receiver. The receiver and the pending intent are released as soon as the request
 * resolves (granted, denied or failed) and on [dispose], so nothing leaks.
 *
 * @param requester shows the system dialog, normally `UsbManager.requestPermission`; it may throw
 *   [UsbFailure], which resolves the request with that failure.
 */
class PermissionBroker internal constructor(
    private val context: Context,
    private val requester: (deviceKey: String, intent: PendingIntent) -> Unit,
) {
    private val lock = Any()
    private val inFlight = HashMap<String, Pending>()
    private var nextRequestCode = 0
    private var disposed = false

    /** Number of devices with a request waiting for the user. */
    val inFlightCount: Int
        get() = synchronized(lock) { inFlight.size }

    /**
     * Requests permission for [deviceKey]; [callback] receives `true` (granted), `false` (denied)
     * or a [UsbFailure]. A request already in flight for the same device is joined, not repeated.
     */
    fun request(deviceKey: String, callback: PermissionCallback) {
        var joined = false
        val started = synchronized(lock) {
            val existing = inFlight[deviceKey]
            when {
                disposed -> null
                existing != null -> {
                    existing.callbacks += callback
                    joined = true
                    existing
                }
                else -> start(deviceKey, callback)
            }
        }
        when {
            started == null -> callback(Result.failure(closedFailure()))
            !joined -> ask(started)
        }
    }

    /** Fails every pending request with [UsbFailure.Closed] and releases its receiver. */
    fun dispose() {
        val pending = synchronized(lock) {
            disposed = true
            inFlight.values.toList().also { inFlight.clear() }
        }
        pending.forEach { request ->
            release(request)
            val failure = Result.failure<Boolean>(closedFailure())
            request.callbacks.forEach { it(failure) }
        }
    }

    /** Called with [lock] held. */
    private fun start(deviceKey: String, callback: PermissionCallback): Pending {
        val pending = Pending(deviceKey, nextRequestCode++, callback)
        inFlight[deviceKey] = pending
        ContextCompat.registerReceiver(
            context,
            pending,
            IntentFilter(ACTION_PERMISSION),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        return pending
    }

    private fun ask(pending: Pending) {
        try {
            requester(pending.deviceKey, pending.intent)
        } catch (failure: UsbFailure) {
            finish(pending, Result.failure(failure))
        }
    }

    private fun finish(pending: Pending, result: Result<Boolean>) {
        val callbacks = synchronized(lock) {
            if (inFlight[pending.deviceKey] !== pending) return
            inFlight.remove(pending.deviceKey)
            pending.callbacks.toList()
        }
        release(pending)
        callbacks.forEach { it(result) }
    }

    private fun release(pending: Pending) {
        context.unregisterReceiver(pending)
        pending.intent.cancel()
    }

    private fun closedFailure() = UsbFailure.Closed("USB permission broker disposed", null)

    /** One in-flight request: its receiver, its pending intent and the callers waiting on it. */
    private inner class Pending(
        val deviceKey: String,
        requestCode: Int,
        first: PermissionCallback,
    ) : BroadcastReceiver() {
        /** Guarded by [lock] while the request is in flight. */
        val callbacks = mutableListOf(first)

        /** Distinct request codes keep one pending intent per request (extras do not count). */
        val intent: PendingIntent = PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(ACTION_PERMISSION)
                .setPackage(context.packageName)
                .putExtra(EXTRA_DEVICE_KEY, deviceKey),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        override fun onReceive(context: Context, intent: Intent) {
            if (intent.getStringExtra(EXTRA_DEVICE_KEY) == deviceKey) {
                finish(this, Result.success(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)))
            }
        }
    }

    companion object {
        /** Private action of the permission answer. */
        const val ACTION_PERMISSION: String = "com.openauri.usb.PERMISSION"

        /** Extra with the device key, used to route answers when several devices are pending. */
        const val EXTRA_DEVICE_KEY: String = "com.openauri.usb.extra.DEVICE_KEY"
    }
}
