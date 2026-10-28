export { PRODUCT_NAME, REPORT_GAP_MS, SETTLE_MS, WRITE_SPACING_MS, GateRejectedError, CommitCollisionError, ConcurrentWriteError, DeviceDisconnectedError, DeviceUnusableError, systemClock, requestCable, writeCurve, applyCurve, writeMany } from "./webhid.mjs";
export { FAKE_PRODUCT_NAME, createFakeClock, FakeFirmware, FakeHIDDevice, FakeHIDConnectionEvent, FakeHID } from "./fake-device.mjs";
