const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;

/**
 * Fetch recent Linear activity for a team via GraphQL.
 * Returns { newIssues, discussedIssues, activeIssues } with transition details and grouped comments.
 */
async function fetchLinearActivity(apiKey, teamId, sinceHours = 24) {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

  const query = `
    query($teamId: String!, $since: DateTimeOrDuration!) {
      team(id: $teamId) {
        issues(
          filter: { updatedAt: { gte: $since } }
          first: 100
          orderBy: updatedAt
        ) {
          nodes {
            identifier
            title
            state { name }
            assignee { displayName }
            priority
            priorityLabel
            updatedAt
            createdAt
            comments(
              filter: { createdAt: { gte: $since } }
              first: 50
            ) {
              nodes {
                body
                createdAt
                user { name displayName }
              }
            }
            history(first: 10) {
              nodes {
                createdAt
                fromState { name }
                toState { name }
                fromAssignee { displayName }
                toAssignee { displayName }
                fromPriority
                toPriority
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ query, variables: { teamId, since } }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const issues = json.data.team.issues.nodes;
  const sinceDate = new Date(since);

  // Filter history entries to the time window
  for (const issue of issues) {
    issue.history.nodes = issue.history.nodes.filter(
      (h) => new Date(h.createdAt) >= sinceDate
    );
  }

  // Determine if an issue has meaningful changes in the window
  function hasMeaningfulChanges(issue) {
    // New comments count as meaningful
    if (issue.comments.nodes.length > 0) return true;

    for (const h of issue.history.nodes) {
      // Status change
      if (h.fromState && h.toState && h.fromState.name !== h.toState.name) return true;
      // Assignment change
      if (h.fromAssignee || h.toAssignee) {
        const from = h.fromAssignee?.displayName || null;
        const to = h.toAssignee?.displayName || null;
        if (from !== to) return true;
      }
      // Priority change — only significant ones
      // Linear: 0=none, 1=urgent, 2=high, 3=medium, 4=low
      if (h.fromPriority != null && h.toPriority != null && h.fromPriority !== h.toPriority) {
        const escalatedToHighOrUrgent = h.toPriority <= 2 && h.toPriority > 0;
        const deEscalatedFromHighOrUrgent = h.fromPriority <= 2 && h.fromPriority > 0 && h.toPriority === 4;
        if (escalatedToHighOrUrgent || deEscalatedFromHighOrUrgent) return true;
      }
    }
    return false;
  }

  // Build transition summaries from history
  function buildTransitions(issue) {
    const statusHops = [];
    const assignmentHops = [];

    // Sort history chronologically
    const sorted = [...issue.history.nodes].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
    );

    for (const h of sorted) {
      if (h.fromState && h.toState && h.fromState.name !== h.toState.name) {
        statusHops.push({ from: h.fromState.name, to: h.toState.name });
      }
      if (h.fromAssignee || h.toAssignee) {
        const from = h.fromAssignee?.displayName || 'Unassigned';
        const to = h.toAssignee?.displayName || 'Unassigned';
        if (from !== to) {
          assignmentHops.push({ from, to });
        }
      }
    }

    // Collapse hops into chains: "Todo → In Progress → In Review"
    let statusChain = null;
    if (statusHops.length > 0) {
      statusChain = statusHops[0].from;
      for (const hop of statusHops) {
        statusChain += ` → ${hop.to}`;
      }
    }

    let assignmentChain = null;
    if (assignmentHops.length > 0) {
      assignmentChain = assignmentHops[0].from;
      for (const hop of assignmentHops) {
        assignmentChain += ` → ${hop.to}`;
      }
    }

    return { statusChain, assignmentChain };
  }

  // New issue = created in window. But if status is beyond Todo, reclassify as active.
  const NEW_STATUSES = ['backlog', 'triage', 'todo'];

  // Categorize
  const newIssues = [];
  const discussedIssues = []; // Still in Backlog/Todo but have recent activity (comments, etc.)
  const activeIssues = [];

  for (const issue of issues) {
    const created = new Date(issue.createdAt);
    const transitions = buildTransitions(issue);
    issue._transitions = transitions;

    // Collect comments under issue, sorted oldest-first, cap body at 500 chars
    issue._comments = issue.comments.nodes
      .map((c) => ({
        author: c.user?.displayName || c.user?.name || 'Unknown',
        body: c.body.length > 500 ? c.body.slice(0, 500) + '...' : c.body,
        createdAt: c.createdAt,
      }))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (created >= sinceDate) {
      const currentStatus = issue.state.name.toLowerCase();
      if (NEW_STATUSES.includes(currentStatus)) {
        newIssues.push(issue);
      } else {
        // Created in window but already progressed — treat as active
        activeIssues.push(issue);
      }
    } else {
      // Existing issue — only include if it had meaningful changes
      if (hasMeaningfulChanges(issue)) {
        const currentStatus = issue.state.name.toLowerCase();
        if (NEW_STATUSES.includes(currentStatus)) {
          // Still in Backlog/Todo but has discussion or other meaningful activity
          discussedIssues.push(issue);
        } else {
          activeIssues.push(issue);
        }
      }
    }
  }

  // Cap comments across all issues at 20 most recent (but keep them grouped per issue)
  const allComments = [];
  for (const issue of [...newIssues, ...discussedIssues, ...activeIssues]) {
    for (const c of issue._comments) {
      allComments.push({ issueId: issue.identifier, createdAt: c.createdAt });
    }
  }
  allComments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const allowedComments = new Set(allComments.slice(0, 20).map((c) => `${c.issueId}:${c.createdAt}`));
  for (const issue of [...newIssues, ...discussedIssues, ...activeIssues]) {
    issue._comments = issue._comments.filter(
      (c) => allowedComments.has(`${issue.identifier}:${c.createdAt}`)
    );
  }

  return { newIssues, discussedIssues, activeIssues };
}

/**
 * Format Linear data into human-readable text for LLM consumption.
 * authorMap maps Linear display names to preferred short names.
 */
function formatLinearData(data, authorMap = {}) {
  const mapName = (name) => {
    if (!name) return 'Unassigned';
    for (const [key, val] of Object.entries(authorMap)) {
      if (name.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(name.toLowerCase())) {
        return val;
      }
    }
    return name;
  };

  function formatIssueBlock(issue, { isNew = false } = {}) {
    const block = [];
    block.push(`${issue.identifier}: ${issue.title} — ${issue.state.name} — ${mapName(issue.assignee?.displayName)} [${issue.priorityLabel}]`);

    const t = issue._transitions;
    if (t?.statusChain) {
      block.push(`  Status: ${t.statusChain}`);
    }
    // Don't show assignment chain for new issues — assignee is already on the title line
    if (t?.assignmentChain && !isNew) {
      block.push(`  Assignment: ${mapName(t.assignmentChain.split(' → ')[0])}${t.assignmentChain.split(' → ').slice(1).map((n) => ` → ${mapName(n)}`).join('')}`);
    }

    if (issue._comments?.length > 0) {
      block.push('  Comments:');
      for (const c of issue._comments) {
        block.push(`    ${mapName(c.author)}: ${c.body}`);
      }
    }

    return block.join('\n');
  }

  const lines = [];

  if (data.newIssues.length > 0) {
    lines.push('=== NEW ISSUES ===');
    for (const issue of data.newIssues) {
      lines.push(formatIssueBlock(issue, { isNew: true }));
      lines.push('');
    }
  }

  if (data.discussedIssues.length > 0) {
    lines.push('=== DISCUSSED ISSUES (Backlog/Todo with recent activity) ===');
    for (const issue of data.discussedIssues) {
      lines.push(formatIssueBlock(issue));
      lines.push('');
    }
  }

  if (data.activeIssues.length > 0) {
    lines.push('=== ACTIVE ISSUES ===');
    for (const issue of data.activeIssues) {
      lines.push(formatIssueBlock(issue));
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = { fetchLinearActivity, formatLinearData };
