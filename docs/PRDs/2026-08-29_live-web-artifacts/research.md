# Live web artifacts: future research

> Companion to [the live web artifacts PRD](prd.md). Directions this
> change deliberately does not take, kept because each was worked
> through far enough that rediscovering it would be expensive — the
> observer-verification framework above all. Nothing here is committed
> scope; the PRD's own Open questions are the decisions still live for
> V1.


Three threads survive this PRD's scope decisions. The storage design
space this section once held was resolved when the team chose to ship
facet storage in V1 (non-goal 11 records what was rejected with it);
what remains is the *deeper* platform tie, and the sharing problem
V1's access model postpones rather than solves.

**1. Artifact state as versioned platform data.** V1 makes artifact
data readable by the platform — the Data view, the export, the agent's
query tools all see the facet's rows — but the rows are still storage,
not *content*: they have no version history, no diffability, no seam
into the resource system. The direction worth researching is
materializing artifact data into the versioning layer at meaningful
boundaries — a snapshot when a poll closes, a resource derived from a
sign-up sheet — using the storage-shape column the versioning layer's
key design decision 7 explicitly reserved for a future producer. Open
problems: which boundaries are meaningful (per-write versioning is
absurd for a counter); whether a snapshot is a CSV resource, a typed
row-set, or both; and how a derived resource cites the artifact it came
from. Nothing in V1 blocks this: the wrapper's export path is the
natural producer, and the facet stays the live store.

**2. Observer verification, for when artifacts read beyond their own
rows.** V1 never has to ask "may this viewer see this data?" beyond
work-stream visibility, because an artifact can only show what was
published with it or collected through it — all of it work-stream
content by construction. The moment a future capability lets an
artifact render *live external data* (the egress-gateway binding of
non-goal 3, or any connector-backed binding), a shared artifact starts
showing viewers data that some of them may not be allowed to see at the
source, and work-stream visibility stops being a sufficient answer.
The reference platform (Cloudflare OS) worked this problem thoroughly,
and its framework is recorded here so the future PRD starts from it:
every data source backing a shared surface needs an *observer
verification* strategy — private-only (never shareable), single-ACL
check (the source is one unit; verify each viewer against it on every
open), per-data-set tracking (the source spans distinct ACLs; log
which sets were actually shown, verify every viewer against every
logged set, re-verify on each open so revocation at the source is
caught), or low-stakes no-op — chosen by one lens: does the binding
span sub-resources with distinct ACLs, and is there a per-viewer
access oracle to check against? Rally's baseline maps to the
single-ACL case with the work stream as the unit, which is exactly why
V1 needs no machinery; the tracking strategy is what connector-backed
artifacts will need, and it is the expensive one — design it with the
binding, not after it.

**3. Starter blueprints.** The reference platform steers its agent to
start every common request from a *blueprint* — pre-written,
already-reviewed code for a known shape (slides, a tracker, a doc) —
and treats "consider a blueprint first" as a standing rule, because a
vetted starting point beats a fresh derivation on quality, tokens, and
latency at once. Rally's V1 equivalent is the skill's two worked
examples, which is a library of size two. The research question is
what a real library looks like here: more Tier-3 skill resources (the
cheapest shape — no new machinery, loaded on demand), or first-class
starter templates with their own registry and provenance. The demand
signal is dogfooding repetition — the third time the model builds a
poll from scratch, the poll blueprint should have existed twice
already.
