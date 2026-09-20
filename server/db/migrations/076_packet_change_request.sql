-- ---------------------------------------------------------------------------
-- The change request a realization packet produced.
-- ---------------------------------------------------------------------------
--
-- `compile()` composed a complete `ObjectiveSubmission` — objective, expected
-- outcome, non-goals and one acceptance condition per buildable gap, each
-- naming the gap behind it — and handed it to a caller that printed it. Nothing
-- submitted it, so a decision-ready packet and a Factory that was waiting for
-- exactly this kind of ask had no row between them. That is this repository's
-- most-recorded defect: a mechanism nothing calls is not a mechanism.
--
-- `campaign_id` already existed and is the wrong column for it. A campaign
-- begins when a person approves; a change request exists before anybody has
-- decided anything, and the gap between those two is precisely where the
-- decision lives. Recording the approved campaign and calling that the link
-- would make an unapproved submission indistinguishable from no submission —
-- and a packet would be resubmitted every time a tick read it.
--
-- Additive. Nothing existing is altered, backfilled or rewritten, and a packet
-- written before this column carries NULL, which is the truthful value: nothing
-- was submitted for it.
-- ---------------------------------------------------------------------------

ALTER TABLE realization_packets ADD COLUMN change_request_id TEXT;

-- One submission per packet, and the index is what makes that true rather than
-- a rule somebody remembers. A packet that submitted twice would put two asks
-- in front of a person for one decision, and approving either would start a
-- campaign the other one's acceptance conditions were never checked against.
-- Partial, because NULL is the ordinary state and several packets have it.
CREATE UNIQUE INDEX idx_realization_packets_change_request
  ON realization_packets (change_request_id)
  WHERE change_request_id IS NOT NULL;
