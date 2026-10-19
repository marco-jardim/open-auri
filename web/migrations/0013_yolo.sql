-- 0013 · YOLO publication (docs/social.md "Classes de curva").
--
-- The server classifies every curve (core `classifyCurve`, web/src/lib/server/social/gate.ts) and
-- caches the class in `curves`, never trusting a client's claim:
--   standard  gate_ok = 1, gate_yolo = 0, gate_reasons = []
--   yolo      gate_ok = 0, gate_yolo = 1, gate_reasons = the codes the YOLO profile waived
--   rejected  gate_ok = 0, gate_yolo = 0, gate_reasons = the standard codes, plus the codes only
--             the YOLO profile reports when it ran
-- A curve is never both: the CHECK below refuses gate_yolo = 1 with gate_ok = 1. Existing rows get
-- gate_yolo = 0 (the class they had), and the next gate version re-classifies them.
ALTER TABLE curves ADD COLUMN gate_yolo INTEGER NOT NULL DEFAULT 0
	CHECK (gate_yolo IN (0, 1) AND (gate_yolo = 0 OR gate_ok = 0));

-- The owner's acknowledgement that a YOLO curve is shown to others in this lineage (publish,
-- append, fork, visibility change or restore with `acknowledge: 'yolo'`). A YOLO head is
-- linkable only with the row of its own (lineage, curve) pair (headPublishableSql in repo.ts);
-- feeds, rankings, S6, S7, packs and the public dump never list YOLO heads. Deleted with the
-- lineage. Curves are content-addressed and never deleted, so the curve reference needs no action.
CREATE TABLE lineage_yolo_acks (
	lineage_id TEXT NOT NULL REFERENCES lineages (id) ON DELETE CASCADE,
	curve_id TEXT NOT NULL REFERENCES curves (id),
	acked_at INTEGER NOT NULL,
	PRIMARY KEY (lineage_id, curve_id)
) WITHOUT ROWID;

-- Invariant §0.12.4, defense in depth (0004): a version may reference a standard or a YOLO curve,
-- never a rejected one (nor a curve that is not there). Who may see a YOLO version is decided by
-- the visibility predicates and the acknowledgements above, not here.
DROP TRIGGER versions_gate_ok;

CREATE TRIGGER versions_gate_ok
BEFORE INSERT ON versions
WHEN (SELECT gate_ok = 1 OR gate_yolo = 1 FROM curves WHERE id = NEW.curve_id) IS NOT 1
BEGIN
	SELECT RAISE(ABORT, 'gate_rejected: the curve passes neither the standard nor the YOLO profile');
END;
