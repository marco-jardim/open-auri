package com.openauri.usb

import com.openauri.usb.FrameGuard.Decision
import com.openauri.usb.FrameGuard.RejectReason
import com.openauri.usb.FrameGuard.RejectReason.BAD_CRC
import com.openauri.usb.FrameGuard.RejectReason.BAD_PADDING
import com.openauri.usb.FrameGuard.RejectReason.BAD_PREAMBLE
import com.openauri.usb.FrameGuard.RejectReason.COMMIT_TOO_SOON
import com.openauri.usb.FrameGuard.RejectReason.COMMIT_WITHOUT_DATA
import com.openauri.usb.FrameGuard.RejectReason.EXPECTED_COMMIT
import com.openauri.usb.FrameGuard.RejectReason.SEQUENCE_TIMEOUT
import com.openauri.usb.FrameGuard.RejectReason.UNEXPECTED_REPORT
import com.openauri.usb.FrameGuard.RejectReason.WRONG_REPORT_ID
import com.openauri.usb.FrameGuard.RejectReason.WRONG_SIZE
import com.openauri.usb.FrameGuard.State
import com.openauri.usb.ProtocolConstants.CRC_OFFSET
import com.openauri.usb.ProtocolConstants.HID_REPORT_ID
import com.openauri.usb.ProtocolConstants.PAYLOAD_SIZE
import com.openauri.usb.ProtocolConstants.REPORT_COUNT
import com.openauri.usb.ProtocolConstants.REPORT_DATA_OFFSET
import com.openauri.usb.ProtocolConstants.REPORT_DATA_SIZE
import com.openauri.usb.ProtocolConstants.REPORT_SIZE
import com.openauri.usb.ProtocolConstants.WRITE_SPACING_MS
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * [FrameGuard] and [FrameGuards]: well-formed writes pass byte for byte, everything else is
 * rejected, never reaches the cable and resets the guard to Idle.
 *
 * Timing follows `writeCurve` (`src/transport/webhid.mjs:495-503`): data report `i` at
 * `start + i * REPORT_GAP_MS`, the commit `REPORT_COUNT * REPORT_GAP_MS + SETTLE_MS` after the
 * start, with both pauses read from the JavaScript.
 */
class FrameGuardTest {

    private val gap = ProtocolFixtureTest.reportGapMs
    private val settle = ProtocolFixtureTest.settleMs
    private val timeout = FrameGuard.SEQUENCE_TIMEOUT_MS
    private val curves = ProtocolFixtureTest.allCurves
    private val reports = ProtocolFixtureTest.presets.first().reports
    private val commit = ProtocolConstants.commitReport()

    /** A transport behind a guard; [cable] holds what actually reached the device. */
    private class Wire(val guard: FrameGuard = FrameGuard()) {
        val cable = mutableListOf<ByteArray>()

        fun send(data: ByteArray, nowMs: Long, reportId: Int = HID_REPORT_ID): Decision {
            val decision = guard.onReport(reportId, data, nowMs)
            if (decision === Decision.Forward) cable += data.copyOf()
            return decision
        }
    }

    // --- Well-formed writes ------------------------------------------------------------------

    @Test
    fun everyReferencePresetAndNeutralPassEndToEnd() {
        assertEquals(12, curves.size)
        for (curve in curves) {
            val wire = Wire()
            assertIdle(wire.guard)
            curve.reports.forEachIndexed { index, report ->
                wire.assertForward(report, index * gap)
                if (index + 1 < REPORT_COUNT) assertReceiving(wire.guard, index + 1) else assertAwaitCommit(wire.guard)
            }
            wire.assertForward(commit, REPORT_COUNT * gap + settle)
            assertIdle(wire.guard)
            assertCable(curve.reports + listOf(commit), wire.cable, curve.name)
        }
    }

    @Test
    fun oneGuardWritesEveryCurveInTurnWithTheTransportSpacing() {
        // writeMany waits WRITE_SPACING_MS between the end of one write and the start of the next.
        val wire = Wire()
        var start = 5_000L
        for (curve in curves) start = wire.writeReports(curve.reports, start) + WRITE_SPACING_MS
        assertCable(curves.flatMap { it.reports + listOf(commit) }, wire.cable, "all curves")
    }

    @Test
    fun wellFormedCurvesPassWhateverTheyEncode() {
        // The guard is not the safety gate: any payload with the preamble and its CRC passes,
        // YOLO curves included, as on the desktop.
        val random = Random(0xCB)
        repeat(50) {
            val payload = random.nextBytes(PAYLOAD_SIZE)
            ProtocolConstants.preamble().copyInto(payload)
            // A real data report 1 never starts with the commit command (see the dedicated test).
            payload[REPORT_DATA_SIZE] = 0
            ProtocolFixtureTest.sealCrc(payload)
            val wire = Wire()
            val payloadReports = ProtocolFixtureTest.reportsFromPayload(payload)
            wire.writeReports(payloadReports, 0)
            assertCable(payloadReports + listOf(commit), wire.cable, "random curve $it")
        }
    }

    // --- Payload integrity -------------------------------------------------------------------

    @Test
    fun flippingAnyBitOfThePayloadFailsOnThePreambleOrTheCrc() {
        val preambleSize = ProtocolConstants.preamble().size
        // The data report holding the last payload byte: the first one that can check the CRC.
        val crcReport = (PAYLOAD_SIZE - 1) / REPORT_DATA_SIZE
        assertEquals(7, crcReport)
        for (curve in curves) {
            for (position in 0 until PAYLOAD_SIZE) {
                for (bit in 0 until Byte.SIZE_BITS) {
                    val payload = curve.payload.copyOf()
                    payload[position] = (payload[position].toInt() xor (1 shl bit)).toByte()
                    val flipped = ProtocolFixtureTest.reportsFromPayload(payload)
                    val (reason, failing) = if (position < preambleSize) BAD_PREAMBLE to 0 else BAD_CRC to crcReport
                    val wire = Wire()
                    for (index in 0 until failing) wire.assertForward(flipped[index], index * gap)
                    wire.assertReject(reason, flipped[failing], failing * gap)
                    for (index in failing + 1 until REPORT_COUNT) {
                        wire.assertReject(UNEXPECTED_REPORT, flipped[index], index * gap)
                    }
                    wire.assertReject(COMMIT_WITHOUT_DATA, commit, REPORT_COUNT * gap + settle)
                    assertEquals(failing, wire.cable.size)
                }
            }
        }
    }

    @Test
    fun nonZeroBytesPastThePayloadAreRejected() {
        // Report 7 carries the last 10 payload bytes; its other 20 bytes and all of report 8 are zero.
        val lastData = REPORT_DATA_OFFSET + (PAYLOAD_SIZE - 7 * REPORT_DATA_SIZE)
        for (position in lastData until REPORT_SIZE) {
            val wire = Wire()
            for (index in 0 until 7) wire.assertForward(reports[index], index * gap)
            wire.assertReject(BAD_PADDING, reports[7].with(position, 0x01), 7 * gap)
        }
        for (position in REPORT_DATA_OFFSET until REPORT_SIZE) {
            val wire = Wire()
            for (index in 0 until 8) wire.assertForward(reports[index], index * gap)
            wire.assertReject(BAD_PADDING, reports[8].with(position, 0x80), 8 * gap)
        }
    }

    // --- Order -------------------------------------------------------------------------------

    @Test
    fun outOfOrderIndexIsRejected() {
        val wire = Wire()
        wire.assertForward(reports[0], 0)
        wire.assertReject(UNEXPECTED_REPORT, reports[2], gap)
        // The sequence is gone: report 1 is no longer expected either.
        wire.assertReject(UNEXPECTED_REPORT, reports[1], 2 * gap)
        assertEquals(1, wire.cable.size)
    }

    @Test
    fun repeatedIndexIsRejected() {
        // A repeated report 0 is a new sequence, not a repeat (see the restart tests).
        for (repeated in 1 until REPORT_COUNT) {
            val wire = Wire()
            for (index in 0..repeated) wire.assertForward(reports[index], index * gap)
            val reason = if (repeated == REPORT_COUNT - 1) EXPECTED_COMMIT else UNEXPECTED_REPORT
            wire.assertReject(reason, reports[repeated], (repeated + 1) * gap)
            assertEquals(repeated + 1, wire.cable.size)
        }
    }

    @Test
    fun missingIndexIsRejected() {
        Wire().assertReject(UNEXPECTED_REPORT, reports[1], 0)
        for (missing in 1 until REPORT_COUNT - 1) {
            val wire = Wire()
            for (index in 0 until missing) wire.assertForward(reports[index], index * gap)
            wire.assertReject(UNEXPECTED_REPORT, reports[missing + 1], missing * gap)
        }
        // Report 8 missing: the commit comes too early.
        val wire = Wire()
        for (index in 0 until REPORT_COUNT - 1) wire.assertForward(reports[index], index * gap)
        wire.assertReject(COMMIT_WITHOUT_DATA, commit, REPORT_COUNT * gap)
    }

    @Test
    fun aSequenceOnlyStartsWithReportZero() {
        val wire = Wire()
        for (index in 1 until REPORT_COUNT) wire.assertReject(UNEXPECTED_REPORT, reports[index], 0)
        for (index in listOf(REPORT_COUNT, 0x7F, 0x80, 0xFF)) {
            wire.assertReject(UNEXPECTED_REPORT, reports[0].with(0, index), 0)
        }
        wire.assertForward(reports[0], 0)
        wire.assertReject(UNEXPECTED_REPORT, reports[1].with(0, 0x81), gap)
    }

    @Test
    fun aValidReportZeroInTheMiddleOfASequenceStartsANewOne() {
        // A live apply cut off part-way never reached report 8, so the cable ignored it: the next
        // preview or "Salvar" starts at once instead of being refused until the timeout.
        val other = ProtocolFixtureTest.presets.last().reports
        for (sent in 1 until REPORT_COUNT) {
            for (restart in listOf(reports, other)) {
                val wire = Wire()
                for (index in 0 until sent) wire.assertForward(reports[index], index * gap)
                wire.writeReports(restart, sent * gap)
                assertEquals(1, wire.guard.abandonedSequences)
                assertCable(restart + listOf(commit), wire.cable.takeLast(REPORT_COUNT + 1), "restart after $sent")
                assertEquals(sent + REPORT_COUNT + 1, wire.cable.size)
            }
        }
        // After all nine data reports, a valid report 0 is a new live apply (see the Live apply tests).
        val wire = Wire()
        val due = wire.sendData(reports, 0)
        wire.assertForward(other[0], due)
        assertReceiving(wire.guard, 1)
    }

    @Test
    fun aPartialSequenceCanNeverBeCommitted() {
        for (sent in 1 until REPORT_COUNT) {
            val wire = Wire()
            for (index in 0 until sent) wire.assertForward(reports[index], index * gap)
            wire.assertReject(COMMIT_WITHOUT_DATA, commit, sent * gap)
            assertEquals(sent, wire.cable.size)
            // A restart then a partial sequence again: still no commit.
            wire.assertForward(reports[0], sent * gap + 1)
            wire.assertForward(reports[1], sent * gap + 2)
            wire.assertForward(reports[0], sent * gap + 3)
            assertEquals(1, wire.guard.abandonedSequences)
            wire.assertReject(COMMIT_WITHOUT_DATA, commit, sent * gap + 4)
            assertTrue(wire.cable.none { it.contentEquals(commit) })
        }
    }

    @Test
    fun aBadReportZeroInTheMiddleOfASequenceIsRejectedWithItsReason() {
        val badPreamble = reports[0].with(REPORT_DATA_OFFSET, reports[0][REPORT_DATA_OFFSET].toInt() xor 0x01)
        for (sent in 1 until REPORT_COUNT) {
            val wire = Wire()
            for (index in 0 until sent) wire.assertForward(reports[index], index * gap)
            wire.assertReject(BAD_PREAMBLE, badPreamble, sent * gap)
            assertEquals(0, wire.guard.abandonedSequences)
            // The partial sequence is gone: its next report is no longer accepted.
            wire.assertReject(UNEXPECTED_REPORT, reports[sent], sent * gap + 1)
            assertEquals(sent, wire.cable.size)
        }
        // Wrong report ID or size on a report 0 in the middle: rejected first, as in every state.
        val wire = Wire()
        for (index in 0..3) wire.assertForward(reports[index], index * gap)
        wire.assertReject(WRONG_REPORT_ID, reports[0], 4 * gap, 0xCA)
        for (index in 0..3) wire.assertForward(reports[index], 5 * gap + index)
        wire.assertReject(WRONG_SIZE, reports[0].copyOf(30), 6 * gap)
        assertEquals(0, wire.guard.abandonedSequences)
    }

    // --- Live apply (9 data reports without the commit) --------------------------------------

    @Test
    fun liveAppliesBackToBackWithinTheTimeoutPass() {
        // The web paces live applies at >= 300 ms; the cable applies each one when report 8 arrives.
        val other = ProtocolFixtureTest.presets.last().reports
        val wire = Wire()
        var start = 0L
        repeat(10) { round ->
            val curve = if (round % 2 == 0) reports else other
            wire.sendData(curve, start)
            assertAwaitCommit(wire.guard)
            assertEquals(round, wire.guard.abandonedSequences)
            start += 300
        }
        // Back to back, no pause at all between report 8 and the next report 0.
        val lastReport = start - 300 + (REPORT_COUNT - 1) * gap
        wire.sendData(reports, lastReport)
        assertEquals(10, wire.guard.abandonedSequences)
        assertEquals(11 * REPORT_COUNT, wire.cable.size)
        assertTrue(wire.cable.none { it.contentEquals(commit) })
    }

    @Test
    fun aLiveApplyCanBeFollowedByACommittedWrite() {
        val wire = Wire()
        wire.sendData(ProtocolFixtureTest.presets.last().reports, 0)
        // "Salvar" right after a live apply: a full write, within the 2000 ms timeout.
        val committedAt = wire.writeReports(reports, 300)
        assertEquals(1, wire.guard.abandonedSequences)
        // The committed write is the last 10 reports on the cable.
        assertCable(reports + listOf(commit), wire.cable.takeLast(REPORT_COUNT + 1), "live then commit")
        // A live apply after the commit, then another commit: still subject to the commit spacing.
        wire.sendData(reports, committedAt + 300)
        wire.assertForward(reports[0], committedAt + 600)
        val due = wire.sendData(reports.drop(1), committedAt + 600 + gap, firstIndex = 1)
        assertTrue(due - committedAt < WRITE_SPACING_MS)
        wire.assertReject(COMMIT_TOO_SOON, commit, due)
        wire.sendData(reports, committedAt + WRITE_SPACING_MS - (REPORT_COUNT * gap + settle))
        wire.assertForward(commit, committedAt + WRITE_SPACING_MS)
    }

    @Test
    fun aLiveApplyDoesNotMoveTheCommitSpacing() {
        assertEquals(2000L, WRITE_SPACING_MS)
        val wire = Wire()
        val t0 = wire.writeReports(reports, 0)
        // A live apply ending at t0 + 1500: if it reset the spacing, the commit below would be refused.
        val liveEnd = t0 + 1500
        wire.sendData(ProtocolFixtureTest.presets.last().reports, liveEnd - (REPORT_COUNT - 1) * gap)
        assertTrue(wire.cable.last().contentEquals(ProtocolFixtureTest.presets.last().reports.last()))
        // "Salvar" whose commit lands at exactly t0 + 2000, the spacing of the first commit.
        val saveStart = t0 + WRITE_SPACING_MS - (REPORT_COUNT * gap + settle)
        assertTrue(saveStart > liveEnd)
        val due = wire.sendData(reports, saveStart)
        assertEquals(t0 + 2000, due)
        wire.assertForward(commit, due)
        assertEquals(1, wire.guard.abandonedSequences)
        assertEquals(2, wire.cable.count { it.contentEquals(commit) })
    }

    @Test
    fun aValidReportZeroThenTheCommitInAwaitCommitIsCommitWithoutData() {
        val wire = Wire()
        val due = wire.sendData(reports, 0)
        wire.assertForward(reports[0], due)
        assertEquals(1, wire.guard.abandonedSequences)
        // The commit now follows only one data report of the new sequence.
        wire.assertReject(COMMIT_WITHOUT_DATA, commit, due + 1)
        assertEquals(REPORT_COUNT + 1, wire.cable.size)
        assertTrue(wire.cable.none { it.contentEquals(commit) })
    }

    @Test
    fun inAwaitCommitAnythingButAValidReportZeroOrTheCommitIsStillRejected() {
        val random = Random(0x11FE)
        val garbage = List(20) { random.nextBytes(REPORT_SIZE).also { bytes -> if (bytes[0].toInt() == 0) bytes[0] = 0x42 } }
        // Report 0 carries 30 payload bytes and no padding: its only content check is the preamble.
        val badPreamble = reports[0].with(REPORT_DATA_OFFSET, reports[0][REPORT_DATA_OFFSET].toInt() xor 0x01)
        val zeroIndexGarbage = List(20) { random.nextBytes(REPORT_SIZE).also { bytes -> bytes[0] = 0 } }
        // A report 0 that fails a check is rejected with the reason of that check.
        val cases = (garbage + reports.drop(1) + listOf(commit.with(REPORT_SIZE - 1, 0x01))).map { it to EXPECTED_COMMIT } +
            (listOf(badPreamble, commit.with(0, 0x00)) + zeroIndexGarbage).map { it to BAD_PREAMBLE }
        for ((data, reason) in cases) {
            val wire = Wire()
            val due = wire.sendData(reports, 0)
            wire.assertReject(reason, data, due)
            assertEquals(0, wire.guard.abandonedSequences)
            // The rejection reset the guard: the uncommitted sequence cannot be committed anymore.
            wire.assertReject(COMMIT_WITHOUT_DATA, commit, due + 1)
            assertEquals(REPORT_COUNT, wire.cable.size)
        }
        // A wrong report ID or size in AwaitCommit is rejected first, as in every state.
        val wire = Wire()
        val due = wire.sendData(reports, 0)
        wire.assertReject(WRONG_REPORT_ID, reports[0], due, 0xCA)
        val sized = Wire()
        sized.sendData(reports, 0)
        sized.assertReject(WRONG_SIZE, reports[0].copyOf(30), due)
    }

    @Test
    fun aLiveRestartStillChecksEveryLaterReport() {
        // The new sequence started in AwaitCommit gets the same checks: order, CRC and padding.
        val flipped = ProtocolFixtureTest.presets.last().payload.copyOf()
        flipped[100] = (flipped[100].toInt() xor 0x01).toByte()
        val badCrc = ProtocolFixtureTest.reportsFromPayload(flipped)
        val wire = Wire()
        val due = wire.sendData(reports, 0)
        for (index in 0 until 7) wire.assertForward(badCrc[index], due + index * gap)
        wire.assertReject(BAD_CRC, badCrc[7], due + 7 * gap)
        val order = Wire()
        val next = order.sendData(reports, 0)
        order.assertForward(reports[0], next)
        order.assertReject(UNEXPECTED_REPORT, reports[2], next + gap)
    }

    // --- Commit ------------------------------------------------------------------------------

    @Test
    fun commitWithoutTheNineReportsIsRejected() {
        Wire().assertReject(COMMIT_WITHOUT_DATA, commit, 0)
        for (sent in 1 until REPORT_COUNT) {
            val wire = Wire()
            for (index in 0 until sent) wire.assertForward(reports[index], index * gap)
            wire.assertReject(COMMIT_WITHOUT_DATA, commit, sent * gap)
            assertTrue(wire.cable.none { it.contentEquals(commit) })
        }
    }

    @Test
    fun theCommitIsNeverTakenForDataReportOne() {
        // The commit starts with 0x01, the index byte of data report 1.
        assertEquals(1, commit[0].toInt())
        val wire = Wire()
        wire.assertForward(reports[0], 0)
        wire.assertReject(COMMIT_WITHOUT_DATA, commit, gap)
        // Nor is anything else that starts with the 5 command bytes, even with a valid CRC.
        val payload = ProtocolFixtureTest.presets.first().payload.copyOf()
        ProtocolConstants.commitCommand().copyInto(payload, REPORT_DATA_SIZE, 1)
        ProtocolFixtureTest.sealCrc(payload)
        val crafted = ProtocolFixtureTest.reportsFromPayload(payload)
        assertTrue(crafted[1].copyOf(5).contentEquals(ProtocolConstants.commitCommand()))
        val other = Wire()
        other.assertForward(crafted[0], 0)
        other.assertReject(COMMIT_WITHOUT_DATA, crafted[1], gap)
        Wire().assertReject(COMMIT_WITHOUT_DATA, commit.with(REPORT_SIZE - 1, 0x01), 0)
    }

    @Test
    fun twoCommitsInARowAreRejected() {
        val wire = Wire()
        val committedAt = wire.writeReports(reports, 0)
        wire.assertReject(COMMIT_WITHOUT_DATA, commit, committedAt + 1)
        wire.assertReject(COMMIT_WITHOUT_DATA, commit, committedAt + 10 * WRITE_SPACING_MS)
        assertEquals(REPORT_COUNT + 1, wire.cable.size)
    }

    @Test
    fun commitAt1999MsAfterThePreviousCommitIsRejected() {
        val wire = Wire()
        val first = wire.writeReports(reports, 0)
        val due = wire.sendData(reports, first + 1999 - (REPORT_COUNT * gap + settle))
        assertEquals(first + 1999, due)
        wire.assertReject(COMMIT_TOO_SOON, commit, due)
        // The data reports went out, the second commit did not.
        assertEquals(2 * REPORT_COUNT + 1, wire.cable.size)
    }

    @Test
    fun commitAt2000MsAfterThePreviousCommitIsForwarded() {
        val wire = Wire()
        val first = wire.writeReports(reports, 0)
        val due = wire.sendData(reports, first + 2000 - (REPORT_COUNT * gap + settle))
        assertEquals(first + WRITE_SPACING_MS, due)
        wire.assertForward(commit, due)
        assertEquals(2 * (REPORT_COUNT + 1), wire.cable.size)
    }

    @Test
    fun aRejectedCommitDoesNotMoveTheSpacing() {
        val wire = Wire()
        val first = wire.writeReports(reports, 0)
        wire.sendData(reports, first + 1)
        wire.assertReject(COMMIT_TOO_SOON, commit, first + 1999)
        // Spacing counts from the last forwarded commit, not from the rejected one.
        for (index in 0 until REPORT_COUNT) wire.assertForward(reports[index], first + 1999)
        wire.assertForward(commit, first + 2000)
    }

    @Test
    fun aCommitAfterTheClockWentBackIsRejected() {
        val wire = Wire()
        val first = wire.writeReports(reports, 1_000_000)
        wire.sendData(reports, 10)
        wire.assertReject(COMMIT_TOO_SOON, commit, 10 + REPORT_COUNT * gap + settle)
        // Far enough back that `now - last` overflows into a large positive number.
        val due = wire.sendData(reports, Long.MIN_VALUE)
        assertTrue(due - first > WRITE_SPACING_MS)
        wire.assertReject(COMMIT_TOO_SOON, commit, due)
    }

    @Test
    fun aCommitWithANonZeroExtraByteIsRejected() {
        // Positions 5..30 are the zero padding (a non-zero extra byte); 0..4 the command itself.
        for (position in 0 until REPORT_SIZE) {
            for (value in listOf(0x01, 0x80, 0xFF)) {
                val altered = commit.with(position, commit[position].toInt() xor value)
                val wire = Wire()
                val due = wire.sendData(reports, 0)
                // Clearing the leading 0x01 makes it a data report 0, judged (and refused) as one.
                val reason = if (altered[0].toInt() == 0) BAD_PREAMBLE else EXPECTED_COMMIT
                wire.assertReject(reason, altered, due)
                assertTrue(wire.cable.none { it.contentEquals(altered) || it.contentEquals(commit) })
            }
        }
    }

    // --- Timeout -----------------------------------------------------------------------------

    @Test
    fun aGapOfMoreThan2000MsBetweenDataReportsDropsTheSequence() {
        val wire = Wire()
        wire.assertForward(reports[0], 0)
        wire.assertForward(reports[1], timeout) // exactly the limit: still in time
        wire.assertReject(SEQUENCE_TIMEOUT, reports[2], 2 * timeout + 1)
        wire.assertReject(UNEXPECTED_REPORT, reports[3], 2 * timeout + 2)
        assertEquals(2, wire.cable.size)
    }

    @Test
    fun aGapOfMoreThan2000MsBeforeTheCommitDropsTheSequence() {
        val last = (REPORT_COUNT - 1) * gap
        val late = Wire()
        late.sendData(reports, 0)
        late.assertReject(SEQUENCE_TIMEOUT, commit, last + timeout + 1)
        val inTime = Wire()
        inTime.sendData(reports, 0)
        inTime.assertForward(commit, last + timeout)
    }

    @Test
    fun aLateReportZeroStartsANewSequence() {
        val wire = Wire()
        for (index in 0..4) wire.assertForward(reports[index], index * gap)
        val restart = 4 * gap + timeout + 1
        wire.assertForward(reports[0], restart)
        assertReceiving(wire.guard, 1)
        // The timed-out sequence had data and no commit: it counts as abandoned.
        assertEquals(1, wire.guard.abandonedSequences)
        val due = wire.sendData(reports.drop(1), restart + gap, firstIndex = 1)
        wire.assertForward(commit, due)
        assertEquals(5 + REPORT_COUNT + 1, wire.cable.size)
        // A late report 0 after AwaitCommit (a live apply long ago) counts too; after a commit it
        // does not, since nothing uncommitted was dropped.
        val live = Wire()
        val liveDue = live.sendData(reports, 0)
        live.assertForward(reports[0], liveDue + timeout + 1)
        assertEquals(1, live.guard.abandonedSequences)
        val committed = Wire()
        val committedAt = committed.writeReports(reports, 0)
        committed.assertForward(reports[0], committedAt + timeout + 1)
        assertEquals(0, committed.guard.abandonedSequences)
    }

    @Test
    fun aLateReportThatCannotStartASequenceIsRejected() {
        val badPreamble = reports[0].with(REPORT_DATA_OFFSET, 0x00)
        for (late in listOf(badPreamble, reports[5], commit)) {
            val wire = Wire()
            for (index in 0..4) wire.assertForward(reports[index], index * gap)
            wire.assertReject(SEQUENCE_TIMEOUT, late, 4 * gap + timeout + 1)
            assertEquals(0, wire.guard.abandonedSequences)
        }
    }

    // --- Report ID and size ------------------------------------------------------------------

    @Test
    fun reportsThatAreNot31BytesAreRejectedInEveryState() {
        for (size in listOf(0, 5, 30, 32, 64)) {
            for (forwarded in 0..REPORT_COUNT) {
                val wire = Wire()
                for (index in 0 until forwarded) wire.assertForward(reports[index], index * gap)
                val next = if (forwarded < REPORT_COUNT) reports[forwarded] else commit
                wire.assertReject(WRONG_SIZE, next.copyOf(size), forwarded * gap)
            }
        }
    }

    @Test
    fun reportIdsOtherThan0xCBAreRejectedInEveryState() {
        for (reportId in listOf(0x00, 0xCA, 0xCC, 0x4B, -1, 0x1CB)) {
            for (forwarded in 0..REPORT_COUNT) {
                val wire = Wire()
                for (index in 0 until forwarded) wire.assertForward(reports[index], index * gap)
                val next = if (forwarded < REPORT_COUNT) reports[forwarded] else commit
                wire.assertReject(WRONG_REPORT_ID, next, forwarded * gap, reportId)
            }
        }
    }

    // --- Rejections never forward ------------------------------------------------------------

    @Test
    fun aRejectedReportNeverReachesTheCable() {
        val random = Random(20261019)
        val wire = Wire()
        val commits = mutableListOf<Long>()
        var now = 0L
        repeat(30_000) {
            now += if (random.nextInt(25) == 0) random.nextLong(1_000, 5_000) else random.nextLong(0, 40)
            val expected = when (val state = wire.guard.state) {
                State.Idle -> reports[0]
                is State.Receiving -> reports[state.received]
                State.AwaitCommit -> commit
            }
            var reportId = HID_REPORT_ID
            val data = when (random.nextInt(16)) {
                0 -> random.nextBytes(REPORT_SIZE)
                1 -> reports[random.nextInt(REPORT_COUNT)]
                2 -> commit
                3 -> expected.copyOf(random.nextInt(0, 40))
                4 -> {
                    val position = random.nextInt(REPORT_SIZE)
                    expected.with(position, expected[position].toInt() xor random.nextInt(1, 256))
                }
                5 -> expected.also { reportId = random.nextInt(0, 256) }
                else -> expected
            }
            val sentBefore = wire.cable.size
            when (val decision = wire.send(data, now, reportId)) {
                is Decision.Reject -> {
                    assertEquals("rejected $decision reached the cable", sentBefore, wire.cable.size)
                    assertIdle(wire.guard)
                }
                Decision.Forward -> {
                    assertEquals(sentBefore + 1, wire.cable.size)
                    assertEquals(HID_REPORT_ID, reportId)
                    if (data.contentEquals(commit)) {
                        assertCommitFollowsAValidPayload(wire.cable)
                        commits += now
                    }
                }
            }
        }
        assertTrue("the fuzz never completed a write", commits.size >= 5)
        commits.zipWithNext { previous, next -> assertTrue(next - previous >= WRITE_SPACING_MS) }
    }

    // --- Reset and per-device registry -------------------------------------------------------

    @Test
    fun physicalCommitStoreSeparatesSerialsButUnknownSerialOverlapsBothWays() {
        val store = CommitSpacingStore()
        val a = PhysicalDeviceIdentity(0x3302, 0x8902, "A")
        val b = a.copy(serialNumber = "B")
        val unknown = a.copy(serialNumber = null)
        assertTrue(store.forward(a, 1000))
        assertTrue(store.forward(b, 1000))
        assertEquals(false, store.forward(a, 2999))
        assertEquals(false, store.forward(unknown, 2999))
        assertTrue(store.forward(unknown, 3000))
        assertEquals(false, store.forward(b, 4999))
        assertEquals(false, store.forward(a, 2000))
        assertTrue(store.forward(a, 5000))
        assertTrue(store.forward(a.copy(vendorId = 1), 1000))
        assertTrue(store.forward(a.copy(productId = 1), 1000))
    }

    @Test
    fun defaultPluginEnvironmentsShareTheProcessStore() {
        fun environment() = OpenAuriUsbPlugin.Environment(
            backend = FakeUsbBackend(),
            claims = ClaimManager(FakeUsbBackend(), TestScheduler(), ClaimManager.IDLE_RELEASE_MS),
            origin = OriginGuard({ UsbPluginHarness.PINNED }, { UsbPluginHarness.PAGE }),
            picker = DevicePicker { _, result -> result(emptyList()) },
            info = AppInfo("test", "test", { "test" }, { true }),
            worker = TestWorker(),
            clock = { 0L },
            isDebug = false,
            onBackgroundError = { throw AssertionError(it) },
        )
        assertSame(CommitSpacingStore.process, environment().commitSpacing)
        assertSame(environment().commitSpacing, environment().commitSpacing)
    }

    @Test
    fun resetDropsTheSequenceButKeepsTheCommitSpacing() {
        val wire = Wire()
        for (index in 0..3) wire.assertForward(reports[index], index * gap)
        wire.guard.reset()
        assertIdle(wire.guard)
        wire.assertReject(UNEXPECTED_REPORT, reports[4], 4 * gap)
        val first = wire.writeReports(reports, 5 * gap)
        wire.guard.reset()
        wire.sendData(reports, first + 1)
        wire.assertReject(COMMIT_TOO_SOON, commit, first + 1000)
    }

    @Test
    fun guardForReturnsOneGuardPerKey() {
        val guards = FrameGuards()
        val a = guards.guardFor("dev/a#1")
        assertSame(a, guards.guardFor("dev/a#1"))
        assertNotSame(a, guards.guardFor("dev/b#2"))
        assertIdle(a)
    }

    @Test
    fun twoDevicesNeverShareASequenceOrACommitSpacing() {
        val guards = FrameGuards()
        val a = "/dev/bus/usb/001/002#1002"
        val b = "/dev/bus/usb/001/003#1003"
        for (index in 0..3) assertSame(Decision.Forward, guards.onReport(a, HID_REPORT_ID, reports[index], index * gap))
        // Report 0 on B starts B's own write and leaves A's sequence alone.
        assertSame(Decision.Forward, guards.onReport(b, HID_REPORT_ID, reports[0], 4 * gap))
        assertReceiving(guards.guardFor(a), 4)
        assertReceiving(guards.guardFor(b), 1)
        for (index in 4 until REPORT_COUNT) {
            assertSame(Decision.Forward, guards.onReport(a, HID_REPORT_ID, reports[index], 5 * gap))
        }
        for (index in 1 until REPORT_COUNT) {
            assertSame(Decision.Forward, guards.onReport(b, HID_REPORT_ID, reports[index], 5 * gap))
        }
        // Commits 10 ms apart: each device has its own spacing.
        assertSame(Decision.Forward, guards.onReport(a, HID_REPORT_ID, commit, 6 * gap))
        assertSame(Decision.Forward, guards.onReport(b, HID_REPORT_ID, commit, 6 * gap + 10))
        // A rejection on A leaves B alone.
        assertSame(Decision.Forward, guards.onReport(b, HID_REPORT_ID, reports[0], 7 * gap))
        assertRejected(guards.onReport(a, HID_REPORT_ID, reports[1], 7 * gap), UNEXPECTED_REPORT)
        assertReceiving(guards.guardFor(b), 1)
    }

    @Test
    fun resetOfOneKeyLeavesTheOthersAlone() {
        val guards = FrameGuards()
        for (key in listOf("a", "b")) {
            for (index in 0..3) guards.onReport(key, HID_REPORT_ID, reports[index], index * gap)
        }
        guards.reset("a")
        guards.reset("never seen")
        assertIdle(guards.guardFor("a"))
        assertReceiving(guards.guardFor("b"), 4)
        assertIdle(guards.guardFor("never seen"))
        assertRejected(guards.onReport("a", HID_REPORT_ID, reports[4], 4 * gap), UNEXPECTED_REPORT)
        assertSame(Decision.Forward, guards.onReport("b", HID_REPORT_ID, reports[4], 4 * gap))
    }

    @Test
    fun registryResetKeepsTheCommitSpacing() {
        val guards = FrameGuards()
        val key = "cable"
        for (index in 0 until REPORT_COUNT) {
            assertSame(Decision.Forward, guards.onReport(key, HID_REPORT_ID, reports[index], 0))
        }
        assertSame(Decision.Forward, guards.onReport(key, HID_REPORT_ID, commit, 200))
        guards.reset(key)
        for (index in 0 until REPORT_COUNT) {
            assertSame(Decision.Forward, guards.onReport(key, HID_REPORT_ID, reports[index], 300))
        }
        assertRejected(guards.onReport(key, HID_REPORT_ID, commit, 500), COMMIT_TOO_SOON)
    }

    // --- Descriptions ------------------------------------------------------------------------

    @Test
    fun decisionsStatesAndReasonsDescribeThemselves() {
        assertEquals("Forward", Decision.Forward.toString())
        assertEquals("Reject(BAD_CRC)", Decision.Reject(BAD_CRC).toString())
        assertEquals("Idle", State.Idle.toString())
        assertEquals("Receiving(3)", State.Receiving(3).toString())
        assertEquals("AwaitCommit", State.AwaitCommit.toString())
        assertEquals(10, RejectReason.entries.size)
        for (reason in RejectReason.entries) {
            assertTrue(reason.name, reason.message.isNotBlank())
            assertSame(reason, RejectReason.valueOf(reason.name))
        }
    }

    // --- Helpers -----------------------------------------------------------------------------

    /** Sends [data] as data reports `firstIndex..`, one per gap; returns when the commit is due. */
    private fun Wire.sendData(data: List<ByteArray>, startMs: Long, firstIndex: Int = 0): Long {
        data.forEachIndexed { offset, report ->
            assertForward(report, startMs + offset * gap)
            val received = firstIndex + offset + 1
            if (received < REPORT_COUNT) assertReceiving(guard, received) else assertAwaitCommit(guard)
        }
        return startMs + (data.size - 1) * gap + gap + settle
    }

    /** A whole write starting at [startMs]; returns when the commit was forwarded. */
    private fun Wire.writeReports(data: List<ByteArray>, startMs: Long): Long {
        val due = sendData(data, startMs)
        assertForward(commit, due)
        assertIdle(guard)
        return due
    }

    private fun Wire.assertForward(data: ByteArray, nowMs: Long) {
        val sentBefore = cable.size
        val decision = send(data, nowMs)
        assertSame("report ${data.firstOrNull()} at $nowMs ms", Decision.Forward, decision)
        assertEquals(sentBefore + 1, cable.size)
    }

    private fun Wire.assertReject(reason: RejectReason, data: ByteArray, nowMs: Long, reportId: Int = HID_REPORT_ID) {
        val sentBefore = cable.size
        assertRejected(send(data, nowMs, reportId), reason)
        assertEquals("a rejected report reached the cable", sentBefore, cable.size)
        assertIdle(guard)
    }

    private fun assertRejected(decision: Decision, reason: RejectReason) {
        val reject = decision as? Decision.Reject ?: throw AssertionError("expected Reject($reason), got $decision")
        assertEquals(reason, reject.reason)
    }

    private fun assertIdle(guard: FrameGuard) = assertSame(State.Idle, guard.state)

    private fun assertAwaitCommit(guard: FrameGuard) = assertSame(State.AwaitCommit, guard.state)

    private fun assertReceiving(guard: FrameGuard, received: Int) {
        val state = guard.state as? State.Receiving ?: throw AssertionError("expected Receiving($received), got ${guard.state}")
        assertEquals(received, state.received)
    }

    private fun assertCable(expected: List<ByteArray>, actual: List<ByteArray>, label: String) {
        assertEquals(label, expected.size, actual.size)
        expected.indices.forEach { assertArrayEquals("$label, report $it", expected[it], actual[it]) }
    }

    /** The 9 reports before a forwarded commit are data reports 0..8 of a payload with a valid preamble and CRC. */
    private fun assertCommitFollowsAValidPayload(cable: List<ByteArray>) {
        assertTrue(cable.size >= REPORT_COUNT + 1)
        val data = cable.subList(cable.size - REPORT_COUNT - 1, cable.size - 1)
        val payload = ByteArray(REPORT_COUNT * REPORT_DATA_SIZE)
        data.forEachIndexed { index, report ->
            assertEquals(index, report[0].toInt())
            report.copyInto(payload, index * REPORT_DATA_SIZE, REPORT_DATA_OFFSET, REPORT_SIZE)
        }
        assertArrayEquals(ProtocolConstants.preamble(), payload.copyOf(ProtocolConstants.preamble().size))
        val stored = (payload[CRC_OFFSET].toInt() and 0xFF) or ((payload[CRC_OFFSET + 1].toInt() and 0xFF) shl 8)
        assertEquals(Crc16Ccitt.compute(payload, 0, CRC_OFFSET), stored)
        assertTrue(payload.drop(PAYLOAD_SIZE).all { it == 0.toByte() })
    }

    private fun ByteArray.with(position: Int, value: Int): ByteArray = copyOf().also { it[position] = value.toByte() }
}
