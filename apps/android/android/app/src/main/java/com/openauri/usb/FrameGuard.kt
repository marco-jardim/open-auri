package com.openauri.usb

import com.openauri.usb.ProtocolConstants.CRC_OFFSET
import com.openauri.usb.ProtocolConstants.HID_REPORT_ID
import com.openauri.usb.ProtocolConstants.PAYLOAD_SIZE
import com.openauri.usb.ProtocolConstants.REPORT_COUNT
import com.openauri.usb.ProtocolConstants.REPORT_DATA_OFFSET
import com.openauri.usb.ProtocolConstants.REPORT_DATA_SIZE
import com.openauri.usb.ProtocolConstants.REPORT_INDEX_OFFSET
import com.openauri.usb.ProtocolConstants.REPORT_SIZE
import com.openauri.usb.ProtocolConstants.WRITE_SPACING_MS

/**
 * Defense-in-depth guard for one 0xCB device: refuses, before anything reaches the USB cable,
 * every report that is not the next one of a well-formed write. It does not replace the safety
 * gate, which runs in JavaScript before any report is sent.
 *
 * A well-formed write is what `writeCurve` sends (`src/transport/webhid.mjs:495-503`): the 9
 * data reports built by `reportsFromPayload` (`src/dsp/eq0xcb.mjs:523-545`), indexes 0 to 8 in
 * order, then the exact [ProtocolConstants.commitReport]. Each report is given to [onReport] as
 * `sendReport(reportId, data)` receives it: the report ID apart and the 31 data bytes.
 *
 * State machine (plan, Anexo D.3):
 * ```
 * Idle         --data report 0 ok-->           Receiving(1)
 * Receiving(n) --data report n ok, n < 8-->    Receiving(n + 1)
 * Receiving(n) --data report 0 ok-->           Receiving(1) (partial sequence abandoned)
 * Receiving(8) --data report 8 ok-->           AwaitCommit
 * AwaitCommit  --exact commit, spacing ok-->   Idle (forwarded)
 * AwaitCommit  --data report 0 ok-->           Receiving(1) (uncommitted sequence abandoned)
 * any state    --anything else-->              Idle (rejected, nothing forwarded)
 * ```
 *
 * Live apply: the cable applies the curve to RAM as soon as data report 8 arrives; only the
 * commit writes it to flash. So the 9 data reports alone are a complete live (uncommitted)
 * apply, and in AwaitCommit a valid data report 0 (same checks as from Idle: report ID, size,
 * preamble; report 0 carries 30 payload bytes and no padding) drops the uncommitted sequence
 * and starts the next one. The same holds in Receiving(n): a live apply cut off part-way never
 * reached report 8, so the cable ignored it, and a valid data report 0 drops it and starts the
 * next preview or write. Each such restart is counted in [abandonedSequences]. A partial
 * sequence can never be committed: the commit needs all 9 data reports of the current sequence.
 * A data report 0 that fails a check is rejected with the reason of that check; any other
 * report in AwaitCommit that is not the exact commit is rejected with
 * [RejectReason.EXPECTED_COMMIT]. The commit spacing only applies to commits.
 *
 * Data reports are forwarded one by one, as they arrive, and each one is checked before it is
 * forwarded, as soon as the bytes it carries allow:
 * - report 0 must start the payload with [ProtocolConstants.preamble];
 * - report 7 completes the 220-byte payload, so the [Crc16Ccitt] of payload bytes 0 until 218
 *   must equal the little-endian CRC in payload bytes 218 and 219 (`src/dsp/eq0xcb.mjs:509-510`);
 * - the bytes past the end of the payload (the tail of report 7, all of report 8) must be zero.
 *
 * So the commit is forwarded only after the payload was reassembled from the 9 reports with a
 * valid preamble and CRC, and only if at least [WRITE_SPACING_MS] passed since the previous
 * commit this guard forwarded.
 *
 * Timeout: once more than [SEQUENCE_TIMEOUT_MS] passed since the previous forwarded report of a
 * sequence, that sequence is dropped (it can no longer get its commit) and the late report is
 * judged as if the guard were idle: a valid data report 0 starts a new sequence and is
 * forwarded, the way a new write starts after an interrupted one; anything else is rejected
 * with [RejectReason.SEQUENCE_TIMEOUT]. That restart drops an uncommitted sequence too, so it is
 * counted in [abandonedSequences]. Within the timeout, a valid data report 0 in Receiving or
 * AwaitCommit also starts a new sequence (see Live apply above).
 *
 * The commit report starts with 0x01, the index byte of data report 1, and whether the firmware
 * looks past the 5 command bytes is unverified (`docs/protocol-0xcb.md:152-155`). So any report
 * that starts with [ProtocolConstants.commitCommand] is taken as a commit attempt, never as data
 * report 1, and is forwarded only as the exact commit report, in AwaitCommit. (A real data
 * report 1 would start that way only if band 0's `b1` word were exactly 0xFF010065.)
 *
 * Any rejection resets the sequence to Idle; the time of the last forwarded commit is kept. The
 * guard does not judge the curve: any well-formed payload passes, YOLO curves included, as on
 * the desktop.
 *
 * Time comes from the caller (`nowMs`, a monotonic clock in milliseconds), so tests drive it.
 * Every public member is synchronized on the guard.
 */
class FrameGuard(
    private val commits: CommitSpacingStore = CommitSpacingStore(),
    private val deviceIdentity: PhysicalDeviceIdentity = PhysicalDeviceIdentity(0, 0, null),
) {

    /** What to do with one report. */
    sealed interface Decision {

        /** Send the report to the device, unchanged. */
        object Forward : Decision {
            override fun toString(): String = "Forward"
        }

        /** Do not send the report. The guard is back to [State.Idle]. */
        class Reject(val reason: RejectReason) : Decision {
            override fun toString(): String = "Reject($reason)"
        }
    }

    /** Why a report was rejected. [message] is meant for the error returned to the caller. */
    enum class RejectReason(val message: String) {
        /** The report ID is not [HID_REPORT_ID]. */
        WRONG_REPORT_ID("report ID is not 0xCB"),

        /** The data is not [REPORT_SIZE] bytes long. */
        WRONG_SIZE("report data is not 31 bytes long"),

        /** Not the next data report: out of order, repeated, missing or not a data report. */
        UNEXPECTED_REPORT("not the next data report of the write sequence"),

        /** Data report 0 does not start the payload with the preamble. */
        BAD_PREAMBLE("payload does not start with the 0xCB preamble"),

        /** A byte past the end of the 220-byte payload is not zero. */
        BAD_PADDING("bytes past the end of the 220-byte payload are not zero"),

        /** The CRC stored in the reassembled payload does not match its bytes. */
        BAD_CRC("payload CRC-16 does not match"),

        /** A report starting with the commit command came before the 9 data reports were forwarded. */
        COMMIT_WITHOUT_DATA("commit without the 9 data reports before it"),

        /** After the 9 data reports, something other than the exact commit report or a data report 0 came. */
        EXPECTED_COMMIT("after the 9 data reports only the exact commit report or a new data report 0 is accepted"),

        /** Less than [WRITE_SPACING_MS] since the previous forwarded commit (or the clock went back). */
        COMMIT_TOO_SOON("commit less than 2000 ms after the previous commit on this device"),

        /** More than [SEQUENCE_TIMEOUT_MS] since the previous report, and not a new valid start. */
        SEQUENCE_TIMEOUT("more than 2000 ms since the previous report of the write sequence"),
    }

    /** Where the guard is in the write sequence (plan, Anexo D.3). */
    sealed interface State {

        /** No sequence in progress: only data report 0 is accepted. */
        object Idle : State {
            override fun toString(): String = "Idle"
        }

        /** [received] data reports (1 to 8) were forwarded; data report [received] is next. */
        class Receiving(val received: Int) : State {
            override fun toString(): String = "Receiving($received)"
        }

        /** The 9 data reports were forwarded and validated: only the commit is accepted. */
        object AwaitCommit : State {
            override fun toString(): String = "AwaitCommit"
        }
    }

    private val preamble = ProtocolConstants.preamble()
    private val commitCommand = ProtocolConstants.commitCommand()
    private val commitReport = ProtocolConstants.commitReport()

    /** The payload reassembled so far; zeroed whenever the sequence is dropped. */
    private val payload = ByteArray(PAYLOAD_SIZE)

    /** Data reports forwarded in this sequence: 0 is Idle, 1 to 8 Receiving, 9 AwaitCommit. */
    private var received = 0

    /** When the last report of this sequence was forwarded; meaningful while [received] > 0. */
    private var lastReportAtMs = 0L

    /** The current state, for diagnostics and tests. */
    val state: State
        @Synchronized get() = when {
            received == 0 -> State.Idle
            received < REPORT_COUNT -> State.Receiving(received)
            else -> State.AwaitCommit
        }

    /**
     * Sequences with data dropped uncommitted because a valid data report 0 started the next one:
     * in Receiving or AwaitCommit (live applies, complete or cut off), or after the timeout. For
     * diagnostics (`UsbDiagnostics.abandonedSequences`) and tests. Never reset.
     */
    var abandonedSequences: Int = 0
        @Synchronized get
        private set

    /**
     * Decides whether the report `(reportId, data)` received at [nowMs] may be sent to the device.
     * On [Decision.Reject] the sequence is back to Idle and the report must not be sent. The
     * caller must send exactly the [data] array it passed here, unmodified.
     */
    @Synchronized
    fun onReport(reportId: Int, data: ByteArray, nowMs: Long): Decision {
        val decision = evaluate(reportId, data, nowMs)
        if (decision is Decision.Reject) clearSequence()
        return decision
    }

    /**
     * Drops the sequence in progress (the device was detached or closed). The time of the last
     * commit is kept, so closing and reopening cannot shorten the spacing between flash writes.
     */
    @Synchronized
    fun reset() {
        clearSequence()
    }

    private fun evaluate(reportId: Int, data: ByteArray, nowMs: Long): Decision {
        if (reportId != HID_REPORT_ID) return reject(RejectReason.WRONG_REPORT_ID)
        if (data.size != REPORT_SIZE) return reject(RejectReason.WRONG_SIZE)
        if (received > 0 && nowMs - lastReportAtMs > SEQUENCE_TIMEOUT_MS) {
            // The sequence in progress had data and no commit: a valid report 0 abandons it.
            val restart = restart(data, nowMs)
            return if (restart is Decision.Forward) restart else reject(RejectReason.SEQUENCE_TIMEOUT)
        }
        if (received > 0 && data[REPORT_INDEX_OFFSET].toInt() == 0) {
            // A new live apply or write. From AwaitCommit the 9 data reports already took effect in
            // the cable's RAM; from Receiving(n) the sequence never reached report 8, so the cable
            // ignored it. Either way it was never committed and can no longer be.
            return restart(data, nowMs)
        }
        if (received == REPORT_COUNT) return acceptCommit(data, nowMs)
        return acceptData(data, nowMs)
    }

    /**
     * Drops the uncommitted sequence in progress and judges [data] as data report 0 of a new one,
     * with the same checks as from Idle; counts the dropped sequence only when [data] passes.
     */
    private fun restart(data: ByteArray, nowMs: Long): Decision {
        clearSequence()
        val decision = acceptData(data, nowMs)
        if (decision is Decision.Forward) abandonedSequences++
        return decision
    }

    /** Data report [received] is expected; [data] is [REPORT_SIZE] bytes long. */
    private fun acceptData(data: ByteArray, nowMs: Long): Decision {
        if (data.startsWith(commitCommand)) return reject(RejectReason.COMMIT_WITHOUT_DATA)
        val index = data[REPORT_INDEX_OFFSET].toInt() and 0xFF
        if (index != received) return reject(RejectReason.UNEXPECTED_REPORT)
        val start = minOf(index * REPORT_DATA_SIZE, PAYLOAD_SIZE)
        val end = minOf(start + REPORT_DATA_SIZE, PAYLOAD_SIZE)
        val dataEnd = REPORT_DATA_OFFSET + (end - start)
        if (!isZero(data, dataEnd, REPORT_SIZE)) return reject(RejectReason.BAD_PADDING)
        data.copyInto(payload, destinationOffset = start, startIndex = REPORT_DATA_OFFSET, endIndex = dataEnd)
        if (index == 0 && !payload.startsWith(preamble)) return reject(RejectReason.BAD_PREAMBLE)
        if (index == CRC_REPORT_INDEX && !payloadCrcMatches()) return reject(RejectReason.BAD_CRC)
        received = index + 1
        lastReportAtMs = nowMs
        return Decision.Forward
    }

    /** The 9 data reports were forwarded and validated; only the exact commit report passes. */
    private fun acceptCommit(data: ByteArray, nowMs: Long): Decision {
        if (!data.contentEquals(commitReport)) return reject(RejectReason.EXPECTED_COMMIT)
        if (!commits.forward(deviceIdentity, nowMs)) {
            return reject(RejectReason.COMMIT_TOO_SOON)
        }
        clearSequence()
        return Decision.Forward
    }

    private fun payloadCrcMatches(): Boolean {
        val low = payload[CRC_OFFSET].toInt() and 0xFF
        val high = payload[CRC_OFFSET + 1].toInt() and 0xFF
        return (low or (high shl 8)) == Crc16Ccitt.compute(payload, 0, CRC_OFFSET)
    }

    private fun clearSequence() {
        received = 0
        payload.fill(0)
    }

    private fun reject(reason: RejectReason): Decision = Decision.Reject(reason)

    companion object {
        /** Longest gap allowed between two reports of one write sequence (plan, Anexo D.3). */
        const val SEQUENCE_TIMEOUT_MS: Long = 2000L

        /** The data report that completes the payload: where the CRC can first be checked. */
        private const val CRC_REPORT_INDEX: Int = (PAYLOAD_SIZE - 1) / REPORT_DATA_SIZE

        /** Whether this array begins with [prefix]; [prefix] is never longer than this array here. */
        private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
            for (index in prefix.indices) {
                if (this[index] != prefix[index]) return false
            }
            return true
        }

        private fun isZero(bytes: ByteArray, fromIndex: Int, toIndex: Int): Boolean {
            for (index in fromIndex until toIndex) {
                if (bytes[index].toInt() != 0) return false
            }
            return true
        }
    }
}

/**
 * One sequence per attachment key; commit spacing is shared by physical identity, not bridge key.
 */
class FrameGuards(private val commits: CommitSpacingStore = CommitSpacingStore()) {

    private val guards = HashMap<String, FrameGuard>()

    /** The guard of [key], created idle on first use. */
    @Synchronized
    fun guardFor(key: String, identity: PhysicalDeviceIdentity = PhysicalDeviceIdentity(0, 0, key)): FrameGuard =
        guards.getOrPut(key) { FrameGuard(commits, identity) }

    /** [FrameGuard.onReport] on the guard of [key]. */
    fun onReport(
        key: String,
        reportId: Int,
        data: ByteArray,
        nowMs: Long,
        identity: PhysicalDeviceIdentity = PhysicalDeviceIdentity(0, 0, key),
    ): FrameGuard.Decision = guardFor(key, identity).onReport(reportId, data, nowMs)

    /**
     * [FrameGuard.reset] on the guard of [key], on detach or close: the sequence is dropped, the
     * commit spacing is kept. An unknown key is ignored.
     */
    @Synchronized
    fun reset(key: String) {
        guards[key]?.reset()
    }

    /** [FrameGuard.abandonedSequences] of [key]; 0 for a key whose guard was never created. */
    @Synchronized
    fun abandonedSequences(key: String): Int = guards[key]?.abandonedSequences ?: 0
}

/** USB identity across reconnects; without a serial all cables of that VID:PID share spacing. */
data class PhysicalDeviceIdentity(val vendorId: Int, val productId: Int, val serialNumber: String?)

/**
 * Last forwarded commit times from the caller's monotonic clock. Check and record are atomic
 * across guards, including guards in different plugin instances. A Forward reserves the time
 * before I/O: a failed or invalidated transfer conservatively keeps that reservation.
 */
class CommitSpacingStore {
    private val lastCommitAtMs = HashMap<PhysicalDeviceIdentity, Long>()

    /** Records a Forward only if at least 2000 ms passed, refusing backwards clocks as well. */
    @Synchronized
    fun forward(identity: PhysicalDeviceIdentity, nowMs: Long): Boolean {
        // An unknown serial overlaps every serial of that VID:PID, in either direction.
        val last = lastCommitAtMs.asSequence().filter { (previous, _) ->
            previous.vendorId == identity.vendorId && previous.productId == identity.productId &&
                (previous.serialNumber == null || identity.serialNumber == null || previous.serialNumber == identity.serialNumber)
        }.maxOfOrNull { it.value }
        if (last != null && (nowMs < last || nowMs - last < WRITE_SPACING_MS)) return false
        lastCommitAtMs[identity] = nowMs
        return true
    }

    companion object {
        /** Process lifetime, deliberately not reset by stop, detach or Activity re-creation. */
        val process: CommitSpacingStore = CommitSpacingStore()
    }
}
