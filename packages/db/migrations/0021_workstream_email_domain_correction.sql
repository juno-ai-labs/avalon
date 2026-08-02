-- The verified Resend receiving subdomain is singular: automation.with-avalon.com.
-- Early development builds used the unregistered plural hostname. Preserve every
-- permanent local part while correcting only that pre-release hostname.
DROP TRIGGER workstreams_email_address_immutable;

UPDATE workstreams
SET email_address = substr(email_address, 1, instr(email_address, '@') - 1)
  || '@automation.with-avalon.com'
WHERE email_address IS NOT NULL
  AND lower(substr(email_address, instr(email_address, '@') + 1)) = 'automations.with-avalon.com';

CREATE TRIGGER workstreams_email_address_immutable
BEFORE UPDATE OF email_address ON workstreams
WHEN OLD.email_address IS NOT NULL
  AND NEW.email_address IS NOT OLD.email_address
BEGIN
  SELECT RAISE(ABORT, 'work stream email addresses are immutable');
END;
