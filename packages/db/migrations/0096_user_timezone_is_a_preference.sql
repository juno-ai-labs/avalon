-- `users.timezone` is what an automation's "9:00 AM" means and what a digest's
-- day is measured in, and the account settings screen invites somebody to set
-- it. Every desktop sign-in then wrote the machine's zone straight over it, so
-- a person who chose New York and later signed in from a laptop still on
-- Pacific had every occurrence they had scheduled moved without being asked.
--
-- This column records which of the two put the current value there, so sign-in
-- can go on seeding an account that has never chosen while leaving a chosen one
-- alone. Existing rows are 'client': nothing recorded a choice before this
-- migration, and calling them all chosen would freeze every account on whatever
-- its last sign-in happened to write.
ALTER TABLE users ADD COLUMN timezone_source TEXT NOT NULL DEFAULT 'client'
  CHECK (timezone_source IN ('client', 'user'));
