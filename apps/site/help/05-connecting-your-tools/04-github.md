---
title: GitHub
description: Let Rally read repositories, work on issues and pull requests, and control which repositories it may touch.
---

Connect GitHub and Rally can find its way around your code, read your issues and pull requests, and help with them. It is the connection most likely to make an engineer say "huh, that's handy" out loud.

## What Rally can do

With GitHub connected, Rally can:

- list and search repositories, browse folders, and read files and commits
- read issues and their comments, open new issues, update them, and comment on them
- read pull requests, including the files they change and the reviews they have had
- open pull requests and submit reviews
- read GitHub Actions runs and check results, so it can look into a failing build

The connection itself does not merge pull requests or push code. When Rally works on code, it does so on its own private Linux computer, in the Terminal described in [Code, data and the Terminal](../04-working-with-rally/03-code-files-and-the-terminal.md). Whether it may push from there is one of the settings below.

Activity in GitHub, such as a new issue, a pull request, a comment, a review, a release or a finished check, can also start a Sidekick. See [Triggers and schedules](../03-sidekicks/04-triggers-and-schedules.md).

## Connecting

GitHub offers both kinds of connection.

- **Connect for me** acts as your own GitHub account. Rally sees what you can see.
- **Connect for organization** (owners and administrators) installs the Rally GitHub App on your GitHub account or GitHub organization, and you choose there which repositories it may reach. Every member can then use it.

1. Open **Settings → Connections** and find the **GitHub** card.
2. Click the button you want and approve in GitHub in your browser.
3. Come back to Rally. The card says **Connected**.

## Choosing which repositories Rally may touch

Once GitHub is connected, a **GitHub** entry appears under **Connections** in the Settings list. It opens **Repository access**. If you have more than one GitHub connection (say your own and the Organization's), pick one from the **Connection** menu at the top.

**Repository availability** decides which repositories Rally can use at all:

- **All repositories**: every repository the GitHub App installation (or your account) can reach.
- **Selected repositories**: only the ones you add to the list below.

**Default remote access** decides what Rally may change on GitHub itself. It appears when availability is **All repositories**:

- **Read-only remote**: Rally can read, and can still edit and commit on its own computer, but it cannot push, open pull requests, file issues, post reviews or make any other change on GitHub.
- **Full remote access**: Rally can do all of those, including pushing from the Terminal.

Below that is **Repositories**, a list you can search with **Search repositories**. Each row says whether the repository is private or public and has its own remote access menu, so you can let Rally push to one repository and only read the rest. With **Selected repositories**, use **Add** and **Remove** to build the list. A repository you add starts as **Read-only remote**.

### Why keep it read-only

Read-only is a good place to start. Rally can still answer questions about the code, review a pull request in the conversation, and try changes on its own computer, and nothing lands on GitHub until you decide it should. When you are ready for Rally to open pull requests or file issues, switch the repositories you trust to **Full remote access**.

### Who can change it

Owners and administrators can change the Organization connection's settings. The owner of a personal connection can change theirs. Everyone else sees the settings greyed out, with a line asking them to ask an organization administrator.

## Things to try

- "Review the open pull request for the billing page and tell me what worries you."
- "Why did the last build on main fail?"
- "File an issue for the login bug we just discussed, with the steps to reproduce."
- "Where in the code do we decide how long a trial lasts?"

## When a repository is missing

Work through these before reinstalling anything:

1. Check that the Rally GitHub App is still installed on the right GitHub account or organization, in GitHub's own settings.
2. Check that the repository is included in that installation, and in Rally's list under **Repository access** if you use **Selected repositories**.
3. Check the **Status** column in **Settings → Connections**. If it says **Reconnect required**, click **Refresh**, or ask an owner or administrator to do so for the Organization connection.

Deleting the GitHub connection in Rally leaves the Rally GitHub App installed on GitHub. Remove it in GitHub's settings if you no longer want it there.

Next, [Linear](05-linear.md).
