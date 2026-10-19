package com.openauri.usb

/**
 * Sizes of the Input, Output and Feature reports that share one report ID.
 *
 * Bits are the sum of Report Size x Report Count over every main item of that type declared
 * under this report ID, constant (padding) fields included. Bytes are the bits rounded up to
 * whole bytes and never include the report ID prefix byte.
 *
 * @property reportId report ID the main items were declared under; 0 when no Report ID item
 *   preceded them.
 * @property inputBits total bits of the Input items.
 * @property outputBits total bits of the Output items.
 * @property featureBits total bits of the Feature items.
 * @property declaresInput true when at least one Input item (even of zero bits) was declared.
 * @property declaresOutput true when at least one Output item (even of zero bits) was declared.
 * @property declaresFeature true when at least one Feature item (even of zero bits) was declared.
 */
data class HidReportInfo(
    val reportId: Int,
    val inputBits: Int,
    val outputBits: Int,
    val featureBits: Int,
    val declaresInput: Boolean,
    val declaresOutput: Boolean,
    val declaresFeature: Boolean,
) {
    /** [inputBits] rounded up to whole bytes. */
    val inputBytes: Int = bitsToBytes(inputBits)

    /** [outputBits] rounded up to whole bytes. */
    val outputBytes: Int = bitsToBytes(outputBits)

    /** [featureBits] rounded up to whole bytes. */
    val featureBytes: Int = bitsToBytes(featureBits)
}

/**
 * A top-level collection of the descriptor (one opened while no other collection was open).
 *
 * @property type collection type from the item data (0x01 = Application, 0x00 = Physical, ...).
 * @property usagePage usage page in effect for the collection's first Usage item: the page
 *   embedded in a 4-byte (extended) Usage, otherwise the current Usage Page global (low 16 bits).
 * @property usage usage ID of the first Usage local item before the collection; 0 when none.
 */
data class HidCollection(
    val type: Int,
    val usagePage: Int,
    val usage: Int,
)

/**
 * Result of [HidReportDescriptor.parse].
 *
 * @property usesReportIds true when the descriptor contains at least one Report ID item. In
 *   that case every report on the wire starts with its report ID byte (HID 1.11 section 6.2.2.7).
 * @property reports report sizes keyed by report ID (0 for main items declared before any
 *   Report ID item).
 * @property collections top-level collections, in declaration order.
 */
data class ParsedDescriptor(
    val usesReportIds: Boolean,
    val reports: Map<Int, HidReportInfo>,
    val collections: List<HidCollection>,
) {
    /** Largest [HidReportInfo.outputBytes] over [reports]; 0 when no Output item is declared. */
    val maxOutputReportBytes: Int = reports.values.maxOfOrNull { it.outputBytes } ?: 0

    /** IDs of the reports that declare at least one Output item, ascending. */
    val outputReportIds: List<Int> = reports.filterValues { it.declaresOutput }.keys.sorted()
}

/**
 * Typed failures of [HidReportDescriptor.parse]. A malformed descriptor always surfaces as one
 * of these subclasses, never as an index or state exception from the JVM.
 *
 * @property offset byte offset, from the start of the descriptor, of the item that failed (the
 *   descriptor length when the problem is only detected at the end).
 */
sealed class HidDescriptorException(val offset: Int, message: String) : Exception(message) {

    /** The item starting at [offset] needs [needed] bytes but only [available] remain. */
    class Truncated(offset: Int, val needed: Int, val available: Int) :
        HidDescriptorException(offset, "item at offset $offset needs $needed bytes, only $available left")

    /** A Pop item at [offset] found the global item stack empty. */
    class PopWithoutPush(offset: Int) :
        HidDescriptorException(offset, "Pop at offset $offset without a matching Push")

    /** Collection and End Collection items do not pair up. */
    sealed class UnbalancedCollection(offset: Int, message: String) : HidDescriptorException(offset, message) {

        /** An End Collection item at [offset] has no open Collection to close. */
        class EndWithoutCollection(offset: Int) :
            UnbalancedCollection(offset, "End Collection at offset $offset without an open Collection")

        /** The descriptor ended with [openCollections] collections still open. */
        class LeftOpen(offset: Int, val openCollections: Int) :
            UnbalancedCollection(offset, "descriptor ended with $openCollections open Collection(s)")
    }

    /**
     * The main item at [offset] declares Report Size x Report Count above
     * [HidReportDescriptor.MAX_ITEM_BITS] bits.
     */
    class ItemTooLarge(offset: Int, val reportSize: Long, val reportCount: Long) :
        HidDescriptorException(
            offset,
            "item at offset $offset declares $reportSize x $reportCount bits, " +
                "above ${HidReportDescriptor.MAX_ITEM_BITS}",
        )

    /**
     * The main item at [offset] grows report [reportId] of its type to [bits] bits, above
     * [HidReportDescriptor.MAX_REPORT_BYTES] bytes.
     */
    class ReportTooLarge(offset: Int, val reportId: Int, val bits: Int) :
        HidDescriptorException(
            offset,
            "item at offset $offset grows report $reportId to $bits bits, " +
                "above ${HidReportDescriptor.MAX_REPORT_BYTES} bytes",
        )

    /** The short item at [offset] has the reserved type bType = 3 and is not the long item prefix 0xFE. */
    class ReservedItem(offset: Int, val prefix: Int) :
        HidDescriptorException(
            offset,
            "reserved item prefix 0x${prefix.toString(16).uppercase().padStart(2, '0')} at offset $offset",
        )

    /** The Report ID item at [offset] declares [reportId], outside 1..255 (0 is reserved). */
    class InvalidReportId(offset: Int, val reportId: Long) :
        HidDescriptorException(offset, "invalid report ID $reportId at offset $offset")
}

/**
 * Parser for USB HID report descriptors (HID 1.11 section 6.2.2), reduced to what output
 * framing needs: report sizes per report ID and type, whether Report ID items are used, and
 * the top-level collections.
 *
 * Items handled:
 * - Global: Usage Page, Report Size, Report ID, Report Count, Push, Pop. Other global tags
 *   (logical and physical ranges, units, reserved tags) are skipped.
 * - Local: Usage. Other local tags are skipped. Local state is cleared after every main item.
 * - Main: Input, Output, Feature, Collection, End Collection. Reserved main tags are skipped.
 * - Short items carry 0, 1, 2 or 4 data bytes (bSize 3 means 4 bytes), read as unsigned
 *   little-endian. Long items (prefix 0xFE, then bDataSize and bLongItemTag) are skipped whole.
 *
 * The input is device-provided and untrusted: every malformed case throws a
 * [HidDescriptorException] subclass.
 */
object HidReportDescriptor {

    /** Largest Report Size x Report Count accepted for one main item, in bits. */
    const val MAX_ITEM_BITS: Long = 65_535

    /**
     * Largest accumulated size of one report (one report ID, one of Input, Output or Feature),
     * in bytes and without the report ID prefix. It matches the 16-bit length fields of the
     * transports (USB wLength, Windows HIDP_CAPS) and bounds the buffers built from it.
     */
    const val MAX_REPORT_BYTES: Int = 65_535

    /**
     * Parses [descriptor] (the raw bytes of the HID report descriptor).
     *
     * @throws HidDescriptorException when the descriptor is malformed.
     */
    fun parse(descriptor: ByteArray): ParsedDescriptor = DescriptorParser(descriptor).parse()
}

private const val LONG_ITEM_PREFIX = 0xFE
private const val LONG_ITEM_HEADER_BYTES = 3

private const val TYPE_MAIN = 0
private const val TYPE_GLOBAL = 1
private const val TYPE_RESERVED = 3

private const val MAIN_INPUT = 0x8
private const val MAIN_OUTPUT = 0x9
private const val MAIN_COLLECTION = 0xA
private const val MAIN_FEATURE = 0xB
private const val MAIN_END_COLLECTION = 0xC

private const val GLOBAL_USAGE_PAGE = 0x0
private const val GLOBAL_REPORT_SIZE = 0x7
private const val GLOBAL_REPORT_ID = 0x8
private const val GLOBAL_REPORT_COUNT = 0x9
private const val GLOBAL_PUSH = 0xA
private const val GLOBAL_POP = 0xB

private const val LOCAL_USAGE = 0x0
private const val EXTENDED_USAGE_BYTES = 4

private const val REPORT_INPUT = 0
private const val REPORT_OUTPUT = 1
private const val REPORT_FEATURE = 2
private const val REPORT_TYPES = 3

private const val MAX_REPORT_ID = 255L
private const val MAX_REPORT_BITS = HidReportDescriptor.MAX_REPORT_BYTES * 8

/** Data byte counts indexed by bSize (bits 0-1 of a short item prefix). */
private val SHORT_ITEM_DATA_BYTES = intArrayOf(0, 1, 2, 4)

private fun bitsToBytes(bits: Int): Int = (bits + 7) / 8

/** Global item state; copied whole by Push (HID 1.11 section 6.2.2.7). */
private class GlobalState(
    var usagePage: Long,
    var reportSize: Long,
    var reportCount: Long,
    var reportId: Int,
) {
    fun snapshot(): GlobalState = GlobalState(usagePage, reportSize, reportCount, reportId)
}

/** First Usage local item seen since the last main item. */
private class PendingUsage(val value: Long, val extended: Boolean)

private class ReportAccumulator {
    val bits = IntArray(REPORT_TYPES)
    val declared = BooleanArray(REPORT_TYPES)

    fun toInfo(reportId: Int): HidReportInfo = HidReportInfo(
        reportId = reportId,
        inputBits = bits[REPORT_INPUT],
        outputBits = bits[REPORT_OUTPUT],
        featureBits = bits[REPORT_FEATURE],
        declaresInput = declared[REPORT_INPUT],
        declaresOutput = declared[REPORT_OUTPUT],
        declaresFeature = declared[REPORT_FEATURE],
    )
}

/** Single-use parser over one descriptor. */
private class DescriptorParser(private val bytes: ByteArray) {
    private var globals = GlobalState(usagePage = 0, reportSize = 0, reportCount = 0, reportId = 0)
    private val globalStack = ArrayDeque<GlobalState>()
    private var pendingUsage: PendingUsage? = null
    private var openCollections = 0
    private var usesReportIds = false
    private val reports = LinkedHashMap<Int, ReportAccumulator>()
    private val collections = mutableListOf<HidCollection>()

    fun parse(): ParsedDescriptor {
        var offset = 0
        while (offset < bytes.size) {
            val prefix = bytes[offset].toInt() and 0xFF
            offset = if (prefix == LONG_ITEM_PREFIX) skipLongItem(offset) else parseShortItem(offset, prefix)
        }
        if (openCollections > 0) {
            throw HidDescriptorException.UnbalancedCollection.LeftOpen(bytes.size, openCollections)
        }
        return ParsedDescriptor(
            usesReportIds = usesReportIds,
            reports = reports.mapValues { (reportId, report) -> report.toInfo(reportId) },
            collections = collections.toList(),
        )
    }

    /** Long item: 0xFE, bDataSize, bLongItemTag, then bDataSize data bytes. Returns the next offset. */
    private fun skipLongItem(offset: Int): Int {
        val available = bytes.size - offset
        val dataSize = if (available > 1) bytes[offset + 1].toInt() and 0xFF else 0
        val itemBytes = LONG_ITEM_HEADER_BYTES + dataSize
        if (available < itemBytes) throw HidDescriptorException.Truncated(offset, itemBytes, available)
        return offset + itemBytes
    }

    /** Short item: prefix (bTag, bType, bSize) then 0, 1, 2 or 4 data bytes. Returns the next offset. */
    private fun parseShortItem(offset: Int, prefix: Int): Int {
        val type = (prefix shr 2) and 0x3
        if (type == TYPE_RESERVED) throw HidDescriptorException.ReservedItem(offset, prefix)
        val dataSize = SHORT_ITEM_DATA_BYTES[prefix and 0x3]
        val itemBytes = 1 + dataSize
        val available = bytes.size - offset
        if (available < itemBytes) throw HidDescriptorException.Truncated(offset, itemBytes, available)
        val tag = prefix shr 4
        val data = readUnsigned(offset + 1, dataSize)
        when (type) {
            TYPE_MAIN -> mainItem(offset, tag, data)
            TYPE_GLOBAL -> globalItem(offset, tag, data)
            else -> localItem(tag, data, dataSize)
        }
        return offset + itemBytes
    }

    private fun readUnsigned(start: Int, size: Int): Long {
        var value = 0L
        for (index in 0 until size) {
            value = value or ((bytes[start + index].toLong() and 0xFF) shl (8 * index))
        }
        return value
    }

    private fun mainItem(offset: Int, tag: Int, data: Long) {
        when (tag) {
            MAIN_INPUT -> addField(offset, REPORT_INPUT)
            MAIN_OUTPUT -> addField(offset, REPORT_OUTPUT)
            MAIN_FEATURE -> addField(offset, REPORT_FEATURE)
            MAIN_COLLECTION -> openCollection(data)
            MAIN_END_COLLECTION -> closeCollection(offset)
        }
        // Local items only apply to the next main item (HID 1.11 section 6.2.2.8).
        pendingUsage = null
    }

    private fun addField(offset: Int, reportType: Int) {
        val itemBits = globals.reportSize.toULong() * globals.reportCount.toULong()
        if (itemBits > HidReportDescriptor.MAX_ITEM_BITS.toULong()) {
            throw HidDescriptorException.ItemTooLarge(offset, globals.reportSize, globals.reportCount)
        }
        val report = reports.getOrPut(globals.reportId) { ReportAccumulator() }
        val totalBits = report.bits[reportType] + itemBits.toInt()
        if (totalBits > MAX_REPORT_BITS) {
            throw HidDescriptorException.ReportTooLarge(offset, globals.reportId, totalBits)
        }
        report.bits[reportType] = totalBits
        report.declared[reportType] = true
    }

    private fun openCollection(collectionType: Long) {
        if (openCollections == 0) {
            val usage = pendingUsage
            val page = if (usage != null && usage.extended) usage.value ushr 16 else globals.usagePage
            collections += HidCollection(
                type = collectionType.toInt(),
                usagePage = (page and 0xFFFF).toInt(),
                usage = ((usage?.value ?: 0L) and 0xFFFF).toInt(),
            )
        }
        openCollections++
    }

    private fun closeCollection(offset: Int) {
        if (openCollections == 0) throw HidDescriptorException.UnbalancedCollection.EndWithoutCollection(offset)
        openCollections--
    }

    private fun globalItem(offset: Int, tag: Int, data: Long) {
        when (tag) {
            GLOBAL_USAGE_PAGE -> globals.usagePage = data
            GLOBAL_REPORT_SIZE -> globals.reportSize = data
            GLOBAL_REPORT_COUNT -> globals.reportCount = data
            GLOBAL_REPORT_ID -> setReportId(offset, data)
            GLOBAL_PUSH -> globalStack.addLast(globals.snapshot())
            GLOBAL_POP -> globals = globalStack.removeLastOrNull() ?: throw HidDescriptorException.PopWithoutPush(offset)
        }
    }

    private fun setReportId(offset: Int, reportId: Long) {
        if (reportId < 1 || reportId > MAX_REPORT_ID) throw HidDescriptorException.InvalidReportId(offset, reportId)
        globals.reportId = reportId.toInt()
        usesReportIds = true
    }

    private fun localItem(tag: Int, data: Long, dataSize: Int) {
        if (tag == LOCAL_USAGE && pendingUsage == null) {
            pendingUsage = PendingUsage(data, extended = dataSize == EXTENDED_USAGE_BYTES)
        }
    }
}
