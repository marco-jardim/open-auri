/** Pure flash-write pacing, loudness warnings and local journal serialization. @module */

export {
  FLASH_STORAGE_KEYS,
  MIN_INTERVAL_MS,
  DAILY_NOTICE_THRESHOLD,
  FLASH_NOTICE_TEXT,
  localDateKey,
  observeFlashState,
  canWriteNow,
  recordWrite,
  dailyNotice,
  parseFlashState,
  serializeFlashState,
} from './flash.mjs';
export {
  LOUDNESS_JUMP_DB,
  LOUDNESS_TOLERANCE_DB,
  LOUDNESS_WARNING_TEXT,
  loudnessWarning,
} from './loudness.mjs';
export {
  JOURNAL_STORAGE_KEY,
  JOURNAL_MAX,
  JOURNAL_WAIVED_MAX,
  validateEntry,
  appendEntry,
  parseJournal,
  serializeJournal,
  lastEntry,
} from './journal.mjs';
