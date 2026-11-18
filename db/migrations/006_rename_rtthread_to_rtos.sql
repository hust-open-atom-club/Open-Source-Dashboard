-- Rename in place to preserve repository references and historical SIG snapshots.
-- A conflicting rtos row fails the transaction instead of splitting history.
BEGIN;

UPDATE special_interest_groups
SET slug = 'rtos', name = 'RTOS SIG'
WHERE slug = 'rtthread';

COMMIT;
