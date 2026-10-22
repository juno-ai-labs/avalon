---
title: Code, data and the Terminal
description: Rally has its own private Linux computer for running code, crunching data and working on GitHub repositories.
---

Some questions are best answered by a calculator, not a conversation. "What is
the average deal size by region in this spreadsheet?" has one right answer,
and the reliable way to get it is to run the numbers. So Rally has a computer
of its own to do that on. Rally calls it the **Terminal**.

## Rally's own computer

The Terminal is a small Linux computer that Rally borrows while it works. It
is a **sandbox**, which means it is sealed off: it is not your Mac, it cannot
see your files unless you give them to Rally, and nothing Rally does in it can
touch your own computer. It is a workshop out the back, where Rally can make a
mess and bring you the finished piece.

On it, Rally can write and run programs in Python, JavaScript, TypeScript and
shell scripts, and use a SQLite database. It can install extra tools when it
needs them. In practice that means it can:

- Do maths properly, rather than in its head.
- Clean up, reshape, merge and convert data files.
- Analyse a spreadsheet, a log file or a pile of CSVs.
- Make charts, datasets, reports, images and zip archives.
- Build documents and small web sites
  (see [Live sites](../06-things-rally-makes/03-live-sites.md)).

You do not need to know any of those languages. Ask for the result and Rally
picks the tool.

## Using it

Ask for what you want:

- "Here is our sales export. Which five customers grew fastest this year? Make
  a bar chart."
- "Convert these three CSVs into one Excel file with a tab each."
- "How many working days are there between now and the launch on 3 March?"
- "Find the duplicate rows in this list and give me a cleaned copy."

Rally loads its **Terminal** plugin and gets to work. Its activity is grouped
under **Computer** in the conversation, with rows such as **Running a
command**, **Writing a file** and **Copying an attachment into the sandbox**
(that last one is Rally taking a file you attached and putting it on its
computer so it can work on it).

When Rally makes something you will want, such as a chart, a cleaned-up file
or a report, it brings it back into the Thread as a file. If it makes the same
file again later, you get a new version of that file rather than a second copy.
Files are covered in [Artifacts](../06-things-rally-makes/01-artifacts.md).

## Which conversations share a computer

Each Thread and Breakout gets its own sandbox. A Sidekick has one shared
sandbox for its setup conversation (the wizard), all its runs, and their
helpers. Its runs keep separate conversations, but can reuse the files left
by the wizard or an earlier run. Different Sidekicks and the Thread that
requested one have separate computers.

Helpers share the computer of the conversation or Sidekick they work for
(see [Helpers, other conversations and receipts](06-helpers-and-receipts.md)).
If two want to change files at once, one waits a moment.

The sandbox is not kept running all the time. After about five idle minutes a
Thread's or Breakout's computer goes to sleep; a Sidekick's sleeps after about
fifteen. Rally wakes it up when it needs it again. Files normally come back,
but anything still running, such as a test web server, does not.

> [!WARNING]
> The sandbox is a workshop, not a filing cabinet. It can be reset when
> permissions change and is deleted after about 30 days without use. Publish
> anything worth keeping as an artifact. Rally can recover published files if
> the sandbox's working copy is lost.

## What it cannot do

The sandbox is a modest machine with a fixed size:

- **Big jobs can run out of room.** It has 2 processors, 4 GB of memory and
  8 GB of disk. A job that needs more stops partway, and Rally tells you it
  failed.
- **One command runs at most 15 minutes.** A long calculation has to be
  split up.
- **Nothing interactive.** Rally cannot run a program that sits waiting for
  someone to type, or leave a server running in the background.
- **Huge outputs are cut off.** A command that prints a vast amount of text
  fails with an output limit.

### Where it may connect on the internet

Code in the sandbox can reach the internet, but only as far as your
Organization allows. An administrator chooses between two settings in
**Settings → Security**, under **Terminal network access**:

- **Trusted only**: the services Rally needs to work, including sites
  published with Rally, plus any extra addresses the Organization approves.
- **Full internet**: any public address.

Either way, the sandbox cannot reach private networks. If Rally says a
download was blocked, this setting is usually why. Ask an administrator, and
see [Organization settings](../10-running-an-organization/03-organization-settings.md).

### When the Terminal is unavailable

The Terminal is not switched on in every region, and the Rally team can pause
it for safety. When it is unavailable, Rally's code tools fail with a message
saying the sandbox is unavailable, and **Settings → Security** shows
**Terminal unavailable**. Rally then answers in the
conversation as best it can without running code.

## Working on GitHub repositories

If you have connected GitHub, Rally can work on your code the way a developer
would. Give it a bug or a small change and get a pull request back to review.

Ask something like:

- "In `acme/website`, the footer year is hard-coded. Fix it and open a PR."
- "Run the tests in `acme/billing` and tell me what is failing."
- "Look at the open PR for the login page and address the review comments."

Rally picks the exact repository from the ones you have given it access to,
copies it onto its sandbox (**Checking out a repository**), reads and edits the
code, runs tests, commits its changes, and opens or updates a pull request
(**Opening a pull request**). If the repository has its own instruction files
for AI agents (files called `AGENTS.md`), Rally reads and follows them.

Some ground rules Rally keeps to:

- **It asks for the least access it needs.** For reading and testing, it uses
  read-only access. It can still edit and commit on its sandbox, but it cannot
  push anything to GitHub. It asks for write access only when the job is to
  push.
- **It works on one branch per Thread.** It pushes only that branch, never
  your main branch.
- **It does not touch your automated build setup.** Rally cannot change files
  in the repository's `.github/workflows` folder.
- **Closed is closed.** Rally does not reopen a pull request that was closed
  or merged.
- **Your word wins.** Instructions in a repository's `AGENTS.md` never give
  Rally extra permissions, and they lose to your instructions and Rally's own
  rules.

Which repositories Rally may touch is controlled from the GitHub connection.
See [GitHub](../05-connecting-your-tools/04-github.md).

> [!TIP]
> Treat Rally's pull request like one from a new colleague: read the diff and
> let your tests run before you merge. It is good, but it is not the one who
> gets paged at 3 a.m.

Next: [Pictures and voices](04-pictures-and-voices.md).
