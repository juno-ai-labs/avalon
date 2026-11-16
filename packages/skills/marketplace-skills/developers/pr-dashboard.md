---
name: "PR dashboard"
description: "See open pull requests and highlight the ones that have gone stale."
icon: "git-pull-request"
color: "violet"
tags:
  - developers
connectors:
  - github
---

Build a live GitHub PR dashboard in this Canvas. Ask me up to two questions for any details I haven't supplied. “Which GitHub repositories should I track?” and “After how long without activity should a pull request be marked stale?”

Load the open pull requests from the selected repositories. Show title, repository, author, draft or review status, last meaningful activity, and the time since that activity. Use commits, review activity, or discussion to determine when a PR last moved, and label the timestamp basis if you have to use GitHub's general updated time. Highlight stale PRs, put the longest-idle ones first, and link each row to GitHub.

Populate the dashboard now and set up a Sidekick to keep PR data current. Use GitHub events where supported and reconcile from the repository when event coverage is incomplete. Calculate staleness from the current time so an idle PR can cross the threshold even without a new event. Keep one row per repository and PR number, and remove closed or merged PRs from the open list.
