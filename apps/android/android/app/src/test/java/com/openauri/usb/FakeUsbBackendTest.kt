package com.openauri.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeUsbBackendTest {
    @Test
    fun interfaceControlClaimRequirementIsOptInAndAppliesToReadsAndWrites() {
        val fake = FakeUsbBackend()
        val device = fake.list(emptyList()).single()
        val hid = checkNotNull(fake.findHidInterface(device))
        fake.grant(device)
        val connection = fake.open(device)
        val setup = ControlSetup(0x21, 0x09, 0x02CB, hid.id)
        fun read() = fake.hidReportDescriptor(connection, hid.id, 4096)
        fun write() = fake.controlOut(connection, setup, ByteArray(32), 1000)

        assertArrayEquals(FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR, read())
        assertEquals(32, write())
        fake.faults.requireInterfaceClaim = true
        for (transfer in listOf({ read(); Unit }, { write(); Unit })) {
            val failure = assertThrows(UsbFailure.TransferFailed::class.java) { transfer() }
            assertEquals("USB transfer to ${device.key} failed (-1): controlTransfer failed", failure.message)
        }
        fake.faults.kernelDriverBound = true
        assertFalse(fake.claim(connection, hid, false))
        assertTrue(fake.claim(connection, hid, true))
        assertArrayEquals(FakeUsbBackend.DEFAULT_REPORT_DESCRIPTOR, read())
        assertEquals(32, write())
        assertTrue(fake.release(connection, hid))
        assertThrows(UsbFailure.TransferFailed::class.java) { read() }
        // Device-recipient controls are not subject to the interface claim rule.
        assertEquals(1, fake.controlOut(connection, ControlSetup(0x00, 1, 0, 0), ByteArray(1), 1000))
        fake.close(connection)
    }
}
