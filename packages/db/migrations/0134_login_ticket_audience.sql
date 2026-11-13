-- Existing and in-flight OAuth tickets remain desktop credentials. Mobile
-- handoffs explicitly opt into cookie-only redemption when they are issued.
ALTER TABLE desktop_login_tickets ADD COLUMN redemption_audience TEXT NOT NULL
  DEFAULT 'desktop' CHECK (redemption_audience IN ('desktop', 'browser'));
