-- ---------------------------------------------------------------------------
-- OCR PROVENANCE
--
-- A page read by OCR is a reading of a picture of a document, not of the
-- document, so the reading has to carry what produced it: which engine, which
-- version, which rendered image, at what resolution and with what confidence.
-- Without that, "this page says X" is a claim nobody can re-check.
--
-- Per-page records live in JSON on the run rather than in their own table: they
-- are always read together with the run, never queried across runs, and one
-- fewer join is worth more here than a shape nobody will use.
-- ---------------------------------------------------------------------------

ALTER TABLE extraction_runs ADD COLUMN ocr_engine TEXT;
ALTER TABLE extraction_runs ADD COLUMN ocr_engine_version TEXT;
ALTER TABLE extraction_runs ADD COLUMN ocr_renderer_version TEXT;

-- [{ "page": 3, "imageHash": "...", "width": 2550, "height": 3300, "dpi": 300,
--    "confidence": 0.94, "durationMs": 812, "blocks": 6, "characters": 1840,
--    "ok": true, "warnings": [...] }]
ALTER TABLE extraction_runs ADD COLUMN ocr_pages TEXT NOT NULL DEFAULT '[]';
