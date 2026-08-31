import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../src/components/Workflows/DelegationTeamCard.tsx", import.meta.url),
  "utf8"
);
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("delegation activity is grouped into member cards instead of a separate timeline", () => {
  assert.match(source, /team\.roster\.map/);
  assert.match(source, /const memberEvents = events\.filter/);
  assert.match(source, /className=\{`side-card delegation-member-card/);
  assert.match(source, /className="delegation-member-activity"/);
  assert.doesNotMatch(source, /delegation-timeline-card/);
  assert.doesNotMatch(styles, /\.delegation-timeline-card\s*\{/);
});

test("member cards show one primary task by default and reveal history on demand", () => {
  assert.match(source, /const primaryEvent = activeEvent \?\? newestFirst\[0\]/);
  assert.match(source, /const visibleEvents = memberExpanded/);
  assert.match(source, /expandedMemberIds\.has\(r\.id\)/);
  assert.match(source, /workflow\.delegation\.showHistory/);
  assert.match(source, /workflow\.delegation\.collapseHistory/);
  assert.match(source, /aria-expanded=\{memberExpanded\}/);
  assert.match(source, /aria-controls=\{`delegation-member-\$\{r\.id\}-activity`\}/);
});

test("task prompts stay compact until their details are expanded", () => {
  assert.match(source, /expandedEventIds\.has\(event\.id\)/);
  assert.match(source, /aria-expanded=\{eventExpanded\}/);
  assert.match(source, /aria-controls=\{`delegation-event-\$\{event\.id\}`\}/);
  assert.match(source, /workflow\.delegation\.details/);
  assert.match(source, /workflow\.delegation\.result/);
  assert.match(
    styles,
    /\.delegation-activity-task\s*\{[^}]*-webkit-line-clamp:\s*2/s
  );
  assert.match(
    styles,
    /\.delegation-activity-task\.expanded\s*\{[^}]*white-space:\s*pre-wrap/s
  );
});

test("status remains readable without relying on timeline colors", () => {
  assert.match(source, /statusLabel\(event\.status\)/);
  assert.match(source, /const memberState = isActive/);
  assert.match(source, /delegation-member-state \$\{memberState\}/);
  assert.match(source, /delegation-event-status \$\{event\.status\}/);
  assert.match(styles, /\.delegation-event-status\s*\{/);
});

test("failed delegation events show their upstream error without expanding details", () => {
  assert.match(source, /event\.status === "failed" \|\| event\.status === "timeout"/);
  assert.match(source, /className="delegation-event-failure"/);
  assert.match(source, /workflow\.failureReason/);
  assert.match(source, /event\.resultSummary && !failureReason/);
  assert.match(styles, /\.delegation-event-failure/);
});
